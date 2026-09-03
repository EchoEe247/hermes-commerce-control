/**
 * CDP Bazaar / Agentic.Market discovery adapter.
 *
 * Public, unauthenticated, read-only. Confirmed against the live API on
 * 2026-08-19:
 *
 *   GET {base}resources?limit&offset
 *     -> { items, pagination: { limit, offset, total }, x402Version }
 *   GET {base}search?query&limit          (limit is capped at 20 upstream)
 *     -> { resources, searchMethod, partialResults, meta, x402Version }
 *
 * Deliberately absent: proxy_tool_call, verify, settle, and any request to a
 * paid resource. This adapter reads the catalogue; it never exercises a service.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalServiceId, normalizeResourceUrl } from "../../core/ids.js";
import { normalizePublicResourceUrl } from "../resource-url.js";
import {
  modeAServiceActionability,
  type ActivityMetrics,
  type ProbeResult,
  type ServiceCandidate,
} from "../../core/models.js";
import type {
  AdapterContext,
  CommerceAdapter,
  PublicationManifest,
  ServiceQuery,
} from "../interface.js";
import { inferMethod, selectPrimaryAccept, type X402Accept } from "../x402-common.js";

/** Upstream rejects limit >= 25 on /search with HTTP 400. */
const MAX_SEARCH_LIMIT = 20;
const MAX_BROWSE_LIMIT = 100;

interface BazaarItem {
  readonly resource?: unknown;
  readonly type?: unknown;
  readonly x402Version?: unknown;
  readonly serviceName?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
  readonly lastUpdated?: unknown;
  readonly quality?: unknown;
  readonly accepts?: unknown;
  readonly extensions?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeQuality(quality: unknown): ActivityMetrics | undefined {
  if (quality === null || typeof quality !== "object") return undefined;
  const q = quality as Record<string, unknown>;
  const calls = q.l30DaysTotalCalls;
  const payers = q.l30DaysUniquePayers;
  const metrics: { calls30d?: number; uniquePayers30d?: number } = {};
  if (typeof calls === "number" && Number.isFinite(calls) && calls >= 0) {
    metrics.calls30d = Math.trunc(calls);
  }
  if (typeof payers === "number" && Number.isFinite(payers) && payers >= 0) {
    metrics.uniquePayers30d = Math.trunc(payers);
  }
  return Object.keys(metrics).length === 0 ? undefined : Object.freeze(metrics);
}

/**
 * Normalizes one Bazaar item into a canonical service candidate.
 *
 * Returns null for an item we cannot identify (no usable resource URL), because
 * a service without a canonical identity cannot be deduplicated or quoted.
 */
export function normalizeBazaarItem(
  item: BazaarItem,
  context: AdapterContext,
  sourceUrl: string,
): ServiceCandidate | null {
  const rawResource = str(item.resource);
  if (rawResource === undefined) return null;

  let resourceUrl: string;
  try {
    // Marketplace-supplied: must pass the SSRF boundary, not just parse.
    resourceUrl = normalizePublicResourceUrl(rawResource);
  } catch {
    // A resource URL we cannot parse (or a non-HTTP scheme) is unusable.
    return null;
  }

  const accepts = asArray(item.accepts) as X402Accept[];
  const primary = selectPrimaryAccept(accepts);
  const method = inferMethod(item.extensions, "POST");
  const observedAt = context.clock();

  const name = str(item.serviceName) ?? str(item.description) ?? resourceUrl;
  const description = str(item.description);
  const tags = asArray(item.tags)
    .map((t) => str(t))
    .filter((t): t is string => t !== undefined);

  const id = canonicalServiceId({
    resourceUrl,
    method,
    protocol: "x402",
    network: primary?.network,
    payTo: primary?.payTo,
  });

  // Evidence: everything here is what the platform returned, so `observed`.
  context.evidence.observe("resource", resourceUrl, "http_api", sourceUrl);
  if (primary?.price?.atomic !== undefined) {
    context.evidence.observe("price_atomic", primary.price.atomic, "http_api", sourceUrl);
  }
  if (primary?.amountRejected === true) {
    context.evidence.tentative(
      "price",
      "upstream advertised an amount that is not a plain integer; price treated as unknown",
      "http_api",
      sourceUrl,
    );
  }
  if (primary?.network !== undefined) {
    context.evidence.observe("network", primary.network, "http_api", sourceUrl);
  }

  const activity = normalizeQuality(item.quality);

  return {
    id,
    kind: "service",
    sources: [
      {
        source: "cdp_bazaar",
        externalId: resourceUrl,
        observedAt,
        sourceUrl,
      },
    ],
    name,
    ...(description === undefined ? {} : { description }),
    resourceUrl,
    method,
    protocol: "x402",
    ...(primary?.network === undefined ? {} : { network: primary.network }),
    ...(primary?.asset === undefined ? {} : { asset: primary.asset }),
    ...(primary?.price === undefined ? {} : { price: primary.price }),
    ...(primary?.payTo === undefined ? {} : { payTo: primary.payTo }),
    health: "ok",
    observedAt,
    ...(activity === undefined ? {} : { activity }),
    tags,
    evidence: context.evidence.records(),
    // Quoting is possible from catalogue data; purchase is preparation-only.
    actionability: modeAServiceActionability({
      canQuote: primary?.price !== undefined,
      canPreparePurchase: primary !== undefined,
    }),
  };
}

export class CdpBazaarAdapter implements CommerceAdapter {
  public readonly id = "cdp_bazaar" as const;

  public constructor(private readonly baseUrl: string) {}

  public capabilities(): AdapterCapabilities {
    return capabilities({
      discoverServices: true,
      inspect: true,
      quote: true,
      preparePurchase: true,
      preparePublish: true,
      walletless: true,
      notes: [
        "public read-only discovery; no API key",
        "never calls proxy_tool_call, verify, settle or a paid resource",
        "search limit is capped at 20 by the upstream API",
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
      const url = this.url("resources", { limit: "1" });
      const body = await context.fetch.json<{ items?: unknown; pagination?: unknown }>(url);
      const items = asArray(body.items);
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `public discovery reachable; ${String(items.length)} item(s) in probe page`,
      };
    } catch (error) {
      const typed = error instanceof CommerceError ? error : null;
      return {
        platform: this.id,
        status: "unreachable",
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
    const q = query.q?.trim();
    const useSearch = q !== undefined && q !== "";

    const url = useSearch
      ? this.url("search", {
          query: q,
          limit: String(Math.min(query.limit ?? MAX_SEARCH_LIMIT, MAX_SEARCH_LIMIT)),
        })
      : this.url("resources", {
          limit: String(Math.min(query.limit ?? 30, MAX_BROWSE_LIMIT)),
          offset: "0",
        });

    const body = await context.fetch.json<Record<string, unknown>>(url);

    // Browse returns `items`; search returns `resources`.
    const rawItems = useSearch ? asArray(body.resources) : asArray(body.items);
    if (!Array.isArray(useSearch ? body.resources : body.items)) {
      throw new CommerceError(
        "UPSTREAM_MALFORMED",
        `CDP Bazaar response did not contain a ${useSearch ? "resources" : "items"} array`,
      );
    }

    const out: ServiceCandidate[] = [];
    for (const raw of rawItems) {
      if (raw === null || typeof raw !== "object") continue;
      const candidate = normalizeBazaarItem(raw as BazaarItem, context, url);
      if (candidate !== null) out.push(candidate);
    }
    return out;
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    // The public API has no per-resource GET, so inspection is a targeted search
    // filtered to an exact resource match.
    const url = this.url("search", { query: externalId, limit: String(MAX_SEARCH_LIMIT) });
    const body = await context.fetch.json<Record<string, unknown>>(url);
    const items = asArray(body.resources);
    const wanted = (() => {
      try {
        return normalizeResourceUrl(externalId);
      } catch {
        return externalId;
      }
    })();

    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const candidate = normalizeBazaarItem(raw as BazaarItem, context, url);
      if (candidate !== null && candidate.resourceUrl === wanted) {
        return {
          platform: this.id,
          externalId,
          inspectedAt: context.clock(),
          service: candidate,
          evidence: context.evidence.records(),
        };
      }
    }
    throw new CommerceError("NOT_FOUND", `no CDP Bazaar resource matched ${externalId}`);
  }

  public async quote(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").Quote> {
    const inspection = await this.inspect(externalId, context);
    const service = inspection.service;
    if (service === undefined) {
      throw new CommerceError("NOT_FOUND", `no quotable resource for ${externalId}`);
    }
    return {
      serviceId: service.id,
      platform: this.id,
      resourceUrl: service.resourceUrl,
      method: service.method,
      protocol: service.protocol,
      ...(service.network === undefined ? {} : { network: service.network }),
      ...(service.asset === undefined ? {} : { asset: service.asset }),
      ...(service.price === undefined ? {} : { price: service.price }),
      ...(service.payTo === undefined ? {} : { payTo: service.payTo }),
      quotedAt: context.clock(),
      evidence: context.evidence.records(),
      executable: false,
    };
  }

  /** Returns the facts an intent needs. Performs no payment. */
  public async preparePurchase(
    externalId: string,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    const quote = await this.quote(externalId, context);
    return {
      platform: this.id,
      resourceUrl: quote.resourceUrl,
      method: quote.method,
      protocol: quote.protocol,
      network: quote.network ?? null,
      asset: quote.asset ?? null,
      price: quote.price ?? null,
      payTo: quote.payTo ?? null,
      settlementNote:
        "x402 settlement would require a signer and live value movement; both are disabled in Mode A",
    };
  }

  /**
   * Builds the publication metadata CDP Bazaar indexing would need.
   * Does not register, publish or announce anything.
   */
  public async preparePublish(
    manifest: PublicationManifest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    void context;
    return {
      platform: this.id,
      target: "cdp_bazaar",
      product: manifest.product,
      version: manifest.version,
      resource: manifest.resourceUrl,
      method: manifest.method,
      x402Version: 2,
      network: manifest.network,
      price: manifest.price,
      description: manifest.description,
      metadataPrepared: true,
      indexingNote:
        "CDP Bazaar indexes a resource after a successful settlement through the CDP facilitator. " +
        "Metadata preparation alone does not create a listing, and settlement is a Stage B2 action.",
      registrationPerformed: false,
    };
  }

  private url(path: string, params: Record<string, string>): string {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }
}
