/**
 * the402 public catalog adapter.
 *
 * Confirmed against the live public API on 2026-08-19:
 *   GET /v1/services/catalog
 *     -> { total, limit, offset, services[], queried_at, referral_hint }
 *   485 services, default limit 20.
 *
 * Query parameters are allowlisted rather than passed through, so a hostile or
 * mistaken caller cannot smuggle arbitrary parameters into the upstream request.
 *
 * This adapter never touches purchase, inquiry, thread, balance or any
 * provider-write endpoint. Its protocol is the402's own marketplace rather than
 * x402, and price is quoted in the platform's units, so no x402 payment metadata
 * is fabricated.
 *
 * The plan designates the402 as a secondary/watch source: if it is unavailable or
 * malformed the adapter degrades and aggregate discovery continues.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalServiceId } from "../../core/ids.js";
import { normalizePublicResourceUrl } from "../resource-url.js";
import { isAuthoritativeAmount, parseAuthoritativeAmount } from "../../core/money.js";
import {
  modeAServiceActionability,
  type PriceRef,
  type ProbeResult,
  type ServiceCandidate,
} from "../../core/models.js";
import type { AdapterContext, CommerceAdapter, ServiceQuery } from "../interface.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Parameters this adapter is willing to send upstream.
 *
 * Anything else is dropped. Documented in the plan as an allowlist precisely so
 * external input cannot shape the request.
 */
const ALLOWED_QUERY_PARAMS = new Set([
  "q",
  "category",
  "service_type",
  "max_price",
  "limit",
  "offset",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parses a the402 price. A variable/absent price stays unknown. */
export function parseThe402Price(raw: unknown): PriceRef | undefined {
  const text = typeof raw === "number" && Number.isFinite(raw) ? raw.toString() : str(raw);
  if (text === undefined) return undefined;
  if (!isAuthoritativeAmount(text)) return undefined;
  const decimal = parseAuthoritativeAmount(text);
  return Object.freeze({
    decimal,
    display: `$${decimal}`,
    currency: "USD",
    // the402 quotes in USD, so a USD figure is the platform's own unit.
    usd: decimal,
  });
}

/**
 * Derives a confidence signal without inflating a new provider's standing.
 *
 * A provider with no completed jobs has unknown reliability. Returning undefined
 * lets ranking apply its documented neutral contribution rather than reading
 * absence as either excellence or failure.
 */
export function providerSuccessRate(service: Record<string, unknown>): number | undefined {
  if (service.provider_is_new === true) return undefined;
  const rate = num(service.provider_completion_rate);
  if (rate === undefined) return undefined;
  return Math.min(1, Math.max(0, rate));
}

interface The402Service {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly category?: unknown;
  readonly service_type?: unknown;
  readonly endpoint?: unknown;
  readonly price?: unknown;
  readonly agent_price?: unknown;
  readonly pricing_model?: unknown;
  readonly estimated_delivery?: unknown;
  readonly provider_name?: unknown;
  readonly provider_verification_tier?: unknown;
  readonly provider_reputation?: unknown;
  readonly provider_confidence?: unknown;
  readonly provider_completed_jobs?: unknown;
  readonly provider_completion_rate?: unknown;
  readonly provider_is_new?: unknown;
  readonly webhook_healthy?: unknown;
  readonly tags?: unknown;
  readonly updated_at?: unknown;
}

export function normalizeThe402Service(
  service: The402Service,
  context: AdapterContext,
  sourceUrl: string,
): ServiceCandidate | null {
  const externalId = str(service.id);
  if (externalId === undefined) return null;

  const rawEndpoint = str(service.endpoint);
  if (rawEndpoint === undefined) return null;
  let resourceUrl: string;
  try {
    // Catalogue-supplied endpoint: must pass the SSRF boundary.
    resourceUrl = normalizePublicResourceUrl(rawEndpoint);
  } catch {
    return null;
  }

  // Prefer the agent-facing price, which is what this control plane would pay.
  const price = parseThe402Price(service.agent_price) ?? parseThe402Price(service.price);
  const serviceType = str(service.service_type) ?? "unknown";
  const observedAt = context.clock();
  const name = str(service.name) ?? externalId;

  const id = canonicalServiceId({
    resourceUrl,
    method: "POST",
    // the402 is its own marketplace protocol, not x402. Labelling it x402 would
    // imply a payment mechanism that does not apply.
    protocol: "the402",
    network: undefined,
    payTo: undefined,
  });

  context.evidence.observe("endpoint", resourceUrl, "http_api", sourceUrl);
  context.evidence.observe("service_type", serviceType, "http_api", sourceUrl);
  if (price?.decimal !== undefined) {
    context.evidence.observe("price_usd", price.decimal, "http_api", sourceUrl);
  } else {
    context.evidence.tentative(
      "price",
      `pricing_model=${String(service.pricing_model ?? "unknown")}; no fixed price is established`,
      "http_api",
      sourceUrl,
    );
  }

  const tier = str(service.provider_verification_tier) ?? "unverified";
  context.evidence.observe("provider_verification_tier", tier, "http_api", sourceUrl);
  if (service.provider_is_new === true) {
    context.evidence.observe("provider_is_new", "true", "http_api", sourceUrl);
  }

  // A failing webhook is a real availability signal, so it downgrades health.
  const health = service.webhook_healthy === false ? "degraded" : "ok";

  const successRate = providerSuccessRate(service as Record<string, unknown>);
  const completedJobs = num(service.provider_completed_jobs);
  const activity =
    successRate === undefined && completedJobs === undefined
      ? undefined
      : Object.freeze({
          ...(completedJobs === undefined ? {} : { calls30d: Math.trunc(completedJobs) }),
          ...(successRate === undefined ? {} : { successRate }),
        });

  const tags = [
    `type:${serviceType}`,
    `tier:${tier}`,
    ...(str(service.category) === undefined ? [] : [`category:${String(service.category)}`]),
    ...(Array.isArray(service.tags)
      ? service.tags.map((t) => str(t)).filter((t): t is string => t !== undefined)
      : []),
  ];

  return {
    id,
    kind: "service",
    sources: [{ source: "the402", externalId, observedAt, sourceUrl }],
    name,
    ...(str(service.description) === undefined
      ? {}
      : { description: str(service.description) as string }),
    resourceUrl,
    method: "POST",
    protocol: "the402",
    ...(price === undefined ? {} : { price }),
    health,
    observedAt,
    ...(activity === undefined ? {} : { activity }),
    tags,
    evidence: context.evidence.records(),
    actionability: modeAServiceActionability({
      canQuote: price !== undefined,
      // Purchase preparation is possible, but the402 purchase is an external
      // write this adapter never performs.
      canPreparePurchase: price !== undefined,
    }),
  };
}

export class The402Adapter implements CommerceAdapter {
  public readonly id = "the402" as const;

  public constructor(private readonly baseUrl = "https://api.the402.ai/") {}

  public capabilities(): AdapterCapabilities {
    return capabilities({
      discoverServices: true,
      inspect: true,
      quote: true,
      walletless: true,
      notes: [
        "read-only /v1/services/catalog with an allowlisted query parameter set",
        "never calls purchase, inquire, thread, balance or provider-write endpoints",
        "protocol is the402's own marketplace, not x402; no x402 metadata is fabricated",
        "degrades to unreachable/degraded without failing aggregate discovery",
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
      const body = await context.fetch.json<Record<string, unknown>>(
        this.catalogUrl({ limit: "1" }),
      );
      const services = Array.isArray(body.services) ? body.services : [];
      const total = num(body.total) ?? services.length;
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `catalog reachable; ${String(total)} listed service(s)`,
      };
    } catch (error) {
      const typed = error instanceof CommerceError ? error : null;
      // the402 is a watch source: report degradation truthfully and move on.
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
    const params: Record<string, string> = {
      limit: String(Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
    };
    if (query.q !== undefined && query.q.trim() !== "") params.q = query.q.trim();
    if (query.maxUsdPrice !== undefined && isAuthoritativeAmount(query.maxUsdPrice)) {
      params.max_price = parseAuthoritativeAmount(query.maxUsdPrice);
    }

    const url = this.catalogUrl(params);
    const body = await context.fetch.json<Record<string, unknown>>(url);
    if (!Array.isArray(body.services)) {
      throw new CommerceError(
        "UPSTREAM_MALFORMED",
        "the402 catalog returned no services array",
      );
    }

    const out: ServiceCandidate[] = [];
    for (const raw of body.services) {
      if (raw === null || typeof raw !== "object") continue;
      const candidate = normalizeThe402Service(raw as The402Service, context, url);
      if (candidate !== null) out.push(candidate);
    }
    return out;
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    const all = await this.discoverServices({ limit: MAX_LIMIT }, context);
    const match = all.find(
      (s) => s.sources.some((src) => src.externalId === externalId) || s.id === externalId,
    );
    if (match === undefined) {
      throw new CommerceError("NOT_FOUND", `no the402 service matched ${externalId}`);
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
      throw new CommerceError("NOT_FOUND", `no quotable the402 service for ${externalId}`);
    }
    return {
      serviceId: service.id,
      platform: this.id,
      resourceUrl: service.resourceUrl,
      method: service.method,
      protocol: service.protocol,
      ...(service.price === undefined ? {} : { price: service.price }),
      quotedAt: context.clock(),
      evidence: context.evidence.records(),
      executable: false,
    };
  }

  /** Builds the catalog URL from allowlisted parameters only. */
  private catalogUrl(params: Record<string, string>): string {
    const url = new URL("/v1/services/catalog", this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (!ALLOWED_QUERY_PARAMS.has(key)) continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
