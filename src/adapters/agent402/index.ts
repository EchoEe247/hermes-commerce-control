/**
 * Agent402.Tools read-only discovery adapter.
 *
 * Confirmed against the live public API on 2026-08-19:
 *
 *   GET /api/find?q=...  -> { query, count, results[], packs, ... }
 *        results carry a combined `route` such as "GET /api/gov-data"
 *   GET /api/pricing     -> { baseUrl, payment, altPayment, categories, endpoints[] }
 *        endpoints carry separate `method` and `path`
 *
 * Prices are display strings ("$0.003"). The sibling `priceUsd` JSON number is
 * deliberately ignored for authoritative purposes: a binary float is not an
 * acceptable representation of a price. The display string is parsed instead.
 *
 * Agent402 also advertises a proof-of-work alternative to paying. That is still
 * a mechanism for *consuming* a paid service, so this adapter never touches it.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalServiceId, normalizeMethod } from "../../core/ids.js";
import { normalizePublicResourceUrl } from "../resource-url.js";
import { parseAuthoritativeAmount } from "../../core/money.js";
import {
  modeAServiceActionability,
  type PriceRef,
  type ProbeResult,
  type ServiceCandidate,
} from "../../core/models.js";
import type {
  AdapterContext,
  CommerceAdapter,
  PublicationManifest,
  ServiceQuery,
} from "../interface.js";

/**
 * Agent402 reports friendly network names; the canonical model uses CAIP-2.
 * Anything not in this table keeps its original label so no identity is faked.
 */
const NETWORK_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  ethereum: "eip155:1",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  celo: "eip155:42220",
  avalanche: "eip155:43114",
});

export function canonicalNetwork(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const key = label.trim().toLowerCase();
  return NETWORK_ALIASES[key] ?? label.trim();
}

/**
 * Parses an Agent402 display price such as "$0.010" into a decimal string.
 * Returns undefined when the string is not machine-readable, rather than
 * inventing a value.
 */
export function parseDisplayPrice(display: unknown): PriceRef | undefined {
  if (typeof display !== "string") return undefined;
  const match = /^\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(display);
  if (match === null) return undefined;
  const raw = match[1];
  if (raw === undefined) return undefined;
  let decimal: string;
  try {
    decimal = parseAuthoritativeAmount(raw);
  } catch {
    return undefined;
  }
  return Object.freeze({
    decimal,
    display: `$${decimal}`,
    currency: "USDC",
    usd: decimal,
  });
}

/** Splits a combined route such as "GET /api/gov-data" into method and path. */
export function splitRoute(route: unknown): { method: string; path: string } | null {
  if (typeof route !== "string") return null;
  const match = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(route);
  if (match === null) return null;
  const method = match[1];
  const path = match[2];
  if (method === undefined || path === undefined) return null;
  try {
    return { method: normalizeMethod(method), path };
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

interface NormalizeInput {
  readonly baseUrl: string;
  readonly method: string;
  readonly path: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly priceDisplay?: unknown;
  readonly slug?: string | undefined;
  readonly network?: string | undefined;
}

function normalizeEntry(
  input: NormalizeInput,
  context: AdapterContext,
  sourceUrl: string,
): ServiceCandidate | null {
  let resourceUrl: string;
  try {
    // Catalogue-supplied baseUrl + path: must pass the SSRF boundary.
    resourceUrl = normalizePublicResourceUrl(new URL(input.path, input.baseUrl).toString());
  } catch {
    return null;
  }

  const price = parseDisplayPrice(input.priceDisplay);
  const network = canonicalNetwork(input.network);
  const observedAt = context.clock();

  const id = canonicalServiceId({
    resourceUrl,
    method: input.method,
    protocol: "x402",
    network,
    // Agent402's catalogue does not publish a payTo address; leaving it
    // undefined keeps the "unknown" sentinel stable and honest.
    payTo: undefined,
  });

  context.evidence.observe("resource", resourceUrl, "http_api", sourceUrl);
  if (price !== undefined) {
    context.evidence.observe("price_usd", price.decimal ?? "", "http_api", sourceUrl);
  } else if (input.priceDisplay !== undefined) {
    context.evidence.tentative(
      "price",
      `upstream price ${JSON.stringify(String(input.priceDisplay))} is not machine-readable; treated as unknown`,
      "http_api",
      sourceUrl,
    );
  }

  const tags = [input.category, input.slug].filter((t): t is string => t !== undefined);

  return {
    id,
    kind: "service",
    sources: [
      {
        source: "agent402",
        externalId: input.slug ?? `${input.method} ${input.path}`,
        observedAt,
        sourceUrl,
      },
    ],
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    resourceUrl,
    method: input.method,
    protocol: "x402",
    ...(network === undefined ? {} : { network }),
    ...(price === undefined
      ? {}
      : { asset: Object.freeze({ symbol: "USDC", decimals: 6 }), price }),
    health: "ok",
    observedAt,
    tags,
    evidence: context.evidence.records(),
    actionability: modeAServiceActionability({
      canQuote: price !== undefined,
      // Payment metadata exists (x402 v2 on the catalogue's declared network)
      // only when we could read a price.
      canPreparePurchase: price !== undefined,
    }),
  };
}

export class Agent402Adapter implements CommerceAdapter {
  public readonly id = "agent402" as const;

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
        "read-only /api/find and /api/pricing",
        "priceUsd float is ignored; the display string is parsed instead",
        "never invokes a paid route, the LLM gateway or the proof-of-work path",
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
      const body = await context.fetch.json<Record<string, unknown>>(this.abs("/api/pricing"));
      const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `catalog reachable; ${String(endpoints.length)} endpoint(s)`,
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
    return q !== undefined && q !== ""
      ? this.discoverByQuery(q, context, query.limit)
      : this.discoverCatalog(context, query.limit);
  }

  /** Query discovery through /api/find. */
  private async discoverByQuery(
    q: string,
    context: AdapterContext,
    limit?: number,
  ): Promise<ServiceCandidate[]> {
    const url = this.abs(`/api/find?q=${encodeURIComponent(q)}`);
    const body = await context.fetch.json<Record<string, unknown>>(url);
    if (!Array.isArray(body.results)) {
      throw new CommerceError("UPSTREAM_MALFORMED", "Agent402 /api/find returned no results array");
    }

    const out: ServiceCandidate[] = [];
    for (const raw of body.results) {
      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const route = splitRoute(entry.route);
      if (route === null) continue;
      const name = str(entry.name) ?? str(entry.slug) ?? route.path;
      const candidate = normalizeEntry(
        {
          baseUrl: this.baseUrl,
          method: route.method,
          path: route.path,
          name,
          description: str(entry.description),
          category: str(entry.category),
          priceDisplay: entry.price,
          slug: str(entry.slug),
          network: "base",
        },
        context,
        url,
      );
      if (candidate !== null) out.push(candidate);
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  /** Full inventory and pricing through /api/pricing. */
  private async discoverCatalog(
    context: AdapterContext,
    limit?: number,
  ): Promise<ServiceCandidate[]> {
    const url = this.abs("/api/pricing");
    const body = await context.fetch.json<Record<string, unknown>>(url);
    if (!Array.isArray(body.endpoints)) {
      throw new CommerceError(
        "UPSTREAM_MALFORMED",
        "Agent402 /api/pricing returned no endpoints array",
      );
    }

    const catalogBase = str(body.baseUrl) ?? this.baseUrl;
    const payment = (body.payment ?? {}) as Record<string, unknown>;
    const network = str(payment.network) ?? "base";

    const out: ServiceCandidate[] = [];
    for (const raw of body.endpoints) {
      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const path = str(entry.path);
      const rawMethod = str(entry.method);
      if (path === undefined || rawMethod === undefined) continue;
      let method: string;
      try {
        method = normalizeMethod(rawMethod);
      } catch {
        continue;
      }
      const candidate = normalizeEntry(
        {
          baseUrl: catalogBase,
          method,
          path,
          name: str(entry.name) ?? str(entry.slug) ?? path,
          description: str(entry.description),
          category: str(entry.category),
          priceDisplay: entry.price,
          slug: str(entry.slug),
          network,
        },
        context,
        url,
      );
      if (candidate !== null) out.push(candidate);
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    const all = await this.discoverCatalog(context);
    const match = all.find(
      (s) =>
        s.sources.some((src) => src.externalId === externalId) ||
        s.id === externalId ||
        s.resourceUrl === externalId,
    );
    if (match === undefined) {
      throw new CommerceError("NOT_FOUND", `no Agent402 endpoint matched ${externalId}`);
    }
    return {
      platform: this.id,
      externalId,
      inspectedAt: context.clock(),
      service: match,
      evidence: context.evidence.records(),
    };
  }

  public async quote(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").Quote> {
    const inspection = await this.inspect(externalId, context);
    const service = inspection.service;
    if (service === undefined) {
      throw new CommerceError("NOT_FOUND", `no quotable Agent402 endpoint for ${externalId}`);
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
      quotedAt: context.clock(),
      evidence: context.evidence.records(),
      executable: false,
    };
  }

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
      price: quote.price ?? null,
      settlementNote:
        "invoking this route would require an x402 payment (or the proof-of-work alternative); " +
        "neither is exercised in Mode A",
    };
  }

  public async preparePublish(
    manifest: PublicationManifest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    void context;
    return {
      platform: this.id,
      target: "agent402",
      product: manifest.product,
      version: manifest.version,
      resource: manifest.resourceUrl,
      method: manifest.method,
      network: manifest.network,
      price: manifest.price,
      metadataPrepared: true,
      listingNote:
        "Agent402 listing is an operator-side catalogue addition; this adapter prepares metadata only",
      registrationPerformed: false,
    };
  }

  private abs(pathAndQuery: string): string {
    return new URL(pathAndQuery, this.baseUrl).toString();
  }
}
