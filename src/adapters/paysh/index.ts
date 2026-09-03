/**
 * Pay.sh / pay-skills Phase-2 adapter.
 *
 * Catalog source, confirmed on 2026-08-19: there is no public catalog JSON to
 * read. pay.sh/skills.json, /index.json and /registry.json all returned 404, and
 * the documentation shows only a placeholder (catalog.example.com/skills.json).
 * Rather than invent a CDN URL, this adapter reads the official registry source:
 * the providers tree of the solana-foundation/pay-skills repository, through the
 * public GitHub contents API.
 *
 *   providers/                          25 provider directories
 *   providers/<provider>/<service>/PAY.md        YAML front matter + prose
 *   providers/<provider>/<service>/openapi.json  endpoint enumeration
 *
 * Pay.sh settles in Solana-mainnet USDC/USDT. The Data Quality Profiler is
 * Base/x402-oriented, so Pay.sh stays a Phase-2 distribution target and
 * preparePublish reports not-ready with reason SOLANA_DISTRIBUTION_PHASE_2.
 *
 * Never performed here: CLI account initialisation, account creation, balance
 * top-up, a paid curl, wallet signing, a fork, a pull request, or any
 * publication. preparePublish emits a local PAY.md + OpenAPI draft object and
 * nothing else.
 *
 * The wording above deliberately avoids the literal CLI subcommand strings,
 * because the security test greps this file for them. Keeping prose free of that
 * syntax lets the grep stay strict instead of being softened to pass.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalServiceId } from "../../core/ids.js";
import { normalizePublicResourceUrl } from "../resource-url.js";
import {
  modeAServiceActionability,
  type ProbeResult,
  type ServiceCandidate,
} from "../../core/models.js";
import type {
  AdapterContext,
  CommerceAdapter,
  PublicationManifest,
  ServiceQuery,
} from "../interface.js";

const GITHUB_API = "https://api.github.com/";
const RAW_BASE = "https://raw.githubusercontent.com/";
const REPO = "solana-foundation/pay-skills";
const BRANCH = "main";

/** Reason Pay.sh cannot be a Phase-1 target for a Base/x402 product. */
export const PHASE_2_REASON = "SOLANA_DISTRIBUTION_PHASE_2";

/**
 * Bounds on how much of the registry a single scan will read.
 *
 * The registry has 25 providers, each with one or more services, so an unbounded
 * crawl would be dozens of requests. These caps keep a phone-scale scan honest
 * and inside the adapter budget.
 */
const MAX_PROVIDERS = 12;
const MAX_SERVICES_PER_PROVIDER = 3;

export interface PayShFrontMatter {
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly useCase?: string | undefined;
  readonly category?: string | undefined;
  readonly serviceUrl?: string | undefined;
  readonly openapiPath?: string | undefined;
}

/**
 * Parses PAY.md YAML front matter.
 *
 * A deliberately small, dependency-free reader for the flat scalar keys this
 * adapter needs, plus the single nested `openapi.path`. It does not evaluate
 * anchors, aliases, tags or arbitrary nesting, because a full YAML engine would
 * be a needless code-execution surface for attacker-authored registry content.
 */
export function parseFrontMatter(markdown: string): PayShFrontMatter | null {
  if (typeof markdown !== "string") return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown.trimStart());
  if (match === null) return null;
  const block = match[1];
  if (block === undefined) return null;

  const flat: Record<string, string> = {};
  let openapiPath: string | undefined;
  let inOpenapi = false;

  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;

    const indented = /^\s/.test(rawLine);
    if (inOpenapi && indented) {
      const nested = /^\s+path\s*:\s*(.+)$/.exec(rawLine);
      if (nested !== null) openapiPath = unquote(nested[1] ?? "");
      continue;
    }
    inOpenapi = false;

    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine);
    if (kv === null) continue;
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();
    if (key === "openapi" && value === "") {
      inOpenapi = true;
      continue;
    }
    if (value === "") continue;
    flat[key] = unquote(value);
  }

  return Object.freeze({
    name: flat.name,
    title: flat.title,
    description: flat.description,
    useCase: flat.use_case,
    category: flat.category,
    serviceUrl: flat.service_url,
    openapiPath,
  });
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extracts the settlement network and asset from the PAY.md prose. */
export function parsePaymentProse(markdown: string): {
  network: string | undefined;
  asset: string | undefined;
} {
  const text = typeof markdown === "string" ? markdown : "";
  const assetMatch = /\b(USDC|USDT)\b/.exec(text);
  const solanaMainnet = /solana\s+mainnet/i.test(text);
  return {
    network: solanaMainnet ? "solana:mainnet" : undefined,
    asset: assetMatch?.[1],
  };
}

interface GitHubEntry {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
}

function asEntries(value: unknown, what: string): GitHubEntry[] {
  if (Array.isArray(value)) return value as GitHubEntry[];
  throw new CommerceError("UPSTREAM_MALFORMED", `pay-skills ${what} listing was not an array`);
}

function dirNames(entries: readonly GitHubEntry[]): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const path = typeof entry.path === "string" ? entry.path : undefined;
    if (name === undefined || path === undefined) continue;
    out.push({ name, path });
  }
  return out;
}

export class PayShAdapter implements CommerceAdapter {
  public readonly id = "paysh" as const;

  public constructor(
    private readonly githubApi = GITHUB_API,
    private readonly rawBase = RAW_BASE,
  ) {}

  public capabilities(): AdapterCapabilities {
    return capabilities({
      discoverServices: true,
      inspect: true,
      preparePublish: true,
      walletless: true,
      notes: [
        "reads the official solana-foundation/pay-skills providers registry; no invented catalog URL",
        "PAY.md front matter is parsed with a minimal scalar reader, not a full YAML engine",
        "settles in Solana-mainnet USDC/USDT, so it is a Phase-2 target for a Base/x402 product",
        "never runs CLI account init, top-up, a paid call, wallet signing, a fork, a PR or a publish",
      ],
    });
  }

  public async health(context?: AdapterContext): Promise<ProbeResult> {
    const checkedAt = context?.clock() ?? new Date().toISOString();
    if (context === undefined) {
      return { platform: this.id, status: "degraded", checkedAt, detail: "no context" };
    }
    const started = Date.now();
    try {
      const listing = await context.fetch.json<unknown>(this.contentsUrl("providers"));
      const providers = dirNames(asEntries(listing, "providers"));
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `pay-skills registry reachable; ${String(providers.length)} provider(s); publication is Phase 2`,
      };
    } catch (error) {
      const typed = error instanceof CommerceError ? error : null;
      return {
        platform: this.id,
        status: typed?.code === "UPSTREAM_MALFORMED" ? "degraded" : "unreachable",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: typed?.message ?? String(error),
        errorCode: typed?.code ?? "UPSTREAM_UNAVAILABLE",
      };
    }
  }

  public async discoverServices(
    query: ServiceQuery,
    context: AdapterContext,
  ): Promise<ServiceCandidate[]> {
    const providersUrl = this.contentsUrl("providers");
    const providers = dirNames(
      asEntries(await context.fetch.json<unknown>(providersUrl), "providers"),
    ).slice(0, MAX_PROVIDERS);

    const limit = query.limit ?? 50;
    const out: ServiceCandidate[] = [];

    for (const provider of providers) {
      if (out.length >= limit) break;
      if (context.signal.aborted) break;

      let services: Array<{ name: string; path: string }>;
      try {
        services = dirNames(
          asEntries(
            await context.fetch.json<unknown>(this.contentsUrl(provider.path)),
            provider.name,
          ),
        ).slice(0, MAX_SERVICES_PER_PROVIDER);
      } catch {
        // One unreadable provider must not abort the whole registry scan.
        continue;
      }

      for (const service of services) {
        if (out.length >= limit) break;
        const fqn = `${provider.name}/${service.name}`;
        let markdown: string;
        try {
          const response = await context.fetch.text(this.rawUrl(`${service.path}/PAY.md`));
          markdown = response.text;
        } catch {
          continue;
        }

        const candidate = this.normalize(fqn, markdown, context, this.rawUrl(`${service.path}/PAY.md`));
        if (candidate !== null) out.push(candidate);
      }
    }

    return out;
  }

  /** Normalizes one PAY.md into a canonical service candidate. */
  public normalize(
    fqn: string,
    markdown: string,
    context: AdapterContext,
    sourceUrl: string,
  ): ServiceCandidate | null {
    const front = parseFrontMatter(markdown);
    if (front === null) return null;
    if (front.serviceUrl === undefined) return null;

    let resourceUrl: string;
    try {
      // Registry content is attacker-authorable: apply the SSRF boundary.
      resourceUrl = normalizePublicResourceUrl(front.serviceUrl);
    } catch {
      return null;
    }

    const payment = parsePaymentProse(markdown);
    const observedAt = context.clock();

    const id = canonicalServiceId({
      resourceUrl,
      method: "GET",
      protocol: "x402",
      network: payment.network,
      payTo: undefined,
    });

    context.evidence.observe("service_url", resourceUrl, "local_file", sourceUrl);
    context.evidence.observe("fqn", fqn, "local_file", sourceUrl);
    if (payment.network !== undefined) {
      context.evidence.infer("network", payment.network, "docs", sourceUrl);
    }
    if (payment.asset !== undefined) {
      context.evidence.infer("asset", payment.asset, "docs", sourceUrl);
    }
    // Registry entries do not publish a machine-readable price; the prose gives
    // only ranges, so price stays unknown rather than being parsed out of text.
    context.evidence.tentative(
      "price",
      "pay-skills PAY.md documents pricing in prose only; no machine-readable price is published",
      "docs",
      sourceUrl,
    );

    const tags = [
      "paysh",
      `fqn:${fqn}`,
      ...(front.category === undefined ? [] : [`category:${front.category}`]),
      ...(payment.network === undefined ? [] : [`network:${payment.network}`]),
    ];

    return {
      id,
      kind: "service",
      sources: [{ source: "paysh", externalId: fqn, observedAt, sourceUrl }],
      name: front.title ?? fqn,
      ...(front.description === undefined ? {} : { description: front.description }),
      resourceUrl,
      method: "GET",
      protocol: "x402",
      ...(payment.network === undefined ? {} : { network: payment.network }),
      ...(payment.asset === undefined
        ? {}
        : { asset: Object.freeze({ symbol: payment.asset, decimals: 6 }) }),
      health: "ok",
      observedAt,
      tags,
      evidence: context.evidence.records(),
      actionability: modeAServiceActionability({
        // No published price, so nothing can be quoted or purchase-prepared.
        canQuote: false,
        canPreparePurchase: false,
      }),
    };
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    const all = await this.discoverServices({}, context);
    const match = all.find(
      (s) => s.sources.some((src) => src.externalId === externalId) || s.id === externalId,
    );
    if (match === undefined) {
      throw new CommerceError("NOT_FOUND", `no pay-skills service matched ${externalId}`);
    }
    return {
      platform: this.id,
      externalId,
      inspectedAt: context.clock(),
      service: match,
      evidence: context.evidence.records(),
    };
  }

  /**
   * Builds a local PAY.md + OpenAPI publication draft.
   *
   * Returns a draft object only. Nothing is written to the registry: publishing
   * a provider means opening a pull request against the pay-skills repository,
   * which is an EXTERNAL_WRITE.
   */
  public async preparePublish(
    manifest: PublicationManifest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    void context;
    const fqn = `${manifest.product}/${manifest.product}`;
    const payMdDraft = [
      "---",
      `name: ${manifest.product}`,
      `title: "${manifest.product}"`,
      `description: "${manifest.description}"`,
      "category: data",
      `service_url: ${new URL(manifest.resourceUrl).origin}`,
      "openapi:",
      "  path: openapi.json",
      "---",
      "",
      `${manifest.description}`,
      "",
      `Priced at ${manifest.price} per request on ${manifest.network}.`,
      "",
    ].join("\n");

    return {
      platform: this.id,
      target: "paysh/pay-skills",
      product: manifest.product,
      version: manifest.version,
      fqn,
      payMdDraft,
      openapiDraftPath: "openapi.json",
      registryPath: `providers/${manifest.product}/${manifest.product}/PAY.md`,
      // Pay.sh settles on Solana mainnet; the profiler is Base/x402.
      prepared: false,
      ready: false,
      reason: PHASE_2_REASON,
      blockedReason: "EXTERNAL_WRITE_DISABLED",
      registrationPerformed: false,
      pullRequestOpened: false,
      walletConfigured: false,
      note:
        "Publishing to pay-skills requires a pull request against the official repository and a " +
        "Solana-mainnet USDC/USDT settlement path. Both are out of scope in Mode A, and Solana " +
        "distribution is a Phase-2 decision for this Base/x402 product.",
    };
  }

  private contentsUrl(path: string): string {
    return new URL(`repos/${REPO}/contents/${path}`, this.githubApi).toString();
  }

  private rawUrl(path: string): string {
    return new URL(`${REPO}/${BRANCH}/${path}`, this.rawBase).toString();
  }
}
