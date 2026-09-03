/**
 * PipRail walletless adapter.
 *
 * PipRail is a payment substrate as well as a cross-index discovery layer, so it
 * is the adapter where the walletless boundary matters most.
 *
 * What this adapter uses, verified against @piprail/sdk 2.15.0 on 2026-08-19:
 *   - `new PipRailClient({ chain })` constructed with NO private key
 *   - `discover({ network })`  read-only, free, reads CDP Bazaar + 402 Index
 *   - `quote(url)`             prices a gated URL without paying
 *
 * What this adapter never calls, even though the client exposes them:
 *   - `planPayment` / `canAfford` — these read the wallet's own holdings, so they
 *     presuppose a wallet. Requesting one is mapped to WALLET_REQUIRED.
 *   - the auto-routing form of fetch, plus payExactRail, payUptoRail,
 *     payAndConfirm, authorize and retryWithProof — all value movement.
 *   - `register`, `claimDomain`, `verifyDomain` — external writes. PipRail would
 *     permit walletless registration; the plan still forbids performing it, so
 *     preparePublish returns metadata only.
 *
 * PIPRAIL_PRIVATE_KEY is never read, set, or referenced as a value anywhere.
 *
 * Terminology note for reviewers: PipRail's own docs use "Mode A" to mean a
 * headless budget-bound agent that DOES pay. This control plane's Mode A is
 * strictly stronger: no payment occurs at all.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalServiceId, normalizeResourceUrl } from "../../core/ids.js";
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
import { selectPrimaryAccept, type X402Accept } from "../x402-common.js";

/**
 * The narrow read-only surface this adapter depends on.
 *
 * Declaring the seam this small is the point: the adapter cannot call a paying
 * method because its dependency type does not have one.
 */
export interface PipRailDiscoveryClient {
  discover(options: { network?: string | undefined }): Promise<unknown>;
  quote?(url: string): Promise<unknown>;
}

export type PipRailClientFactory = () => Promise<PipRailDiscoveryClient>;

/**
 * Lazily constructs a walletless official client.
 *
 * No key material is passed. If the SDK is unavailable on this runtime the
 * adapter degrades rather than failing the aggregate.
 */
export const defaultPipRailClientFactory: PipRailClientFactory = async () => {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("@piprail/sdk")) as unknown as Record<string, unknown>;
  } catch (cause) {
    throw new CommerceError(
      "ADAPTER_DISABLED",
      "@piprail/sdk could not be imported on this runtime",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  const Ctor = mod.PipRailClient as
    | (new (options: { chain: string }) => PipRailDiscoveryClient)
    | undefined;
  if (typeof Ctor !== "function") {
    throw new CommerceError("ADAPTER_DISABLED", "@piprail/sdk did not export PipRailClient");
  }
  // Constructed with a chain only. No key, no account, no signer.
  return new Ctor({ chain: "base" });
};

interface PipRailResource {
  readonly resource?: unknown;
  readonly source?: unknown;
  readonly description?: unknown;
  readonly rails?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asResourceArray(value: unknown): PipRailResource[] {
  if (Array.isArray(value)) return value as PipRailResource[];
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["resources", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as PipRailResource[];
    }
  }
  throw new CommerceError("UPSTREAM_MALFORMED", "PipRail discover did not return an array");
}

export function normalizePipRailResource(
  entry: PipRailResource,
  context: AdapterContext,
  sourceRef: string,
): ServiceCandidate | null {
  const rawResource = str(entry.resource);
  if (rawResource === undefined) return null;
  let resourceUrl: string;
  try {
    // Index-supplied: must pass the SSRF boundary, not just parse.
    resourceUrl = normalizePublicResourceUrl(rawResource);
  } catch {
    return null;
  }

  const rails = Array.isArray(entry.rails) ? (entry.rails as X402Accept[]) : [];
  const primary = selectPrimaryAccept(rails);
  const observedAt = context.clock();
  const description = str(entry.description);
  const upstreamIndex = str(entry.source);

  // PipRail aggregates other indexes, so its method is not published. x402
  // resources are overwhelmingly POST; recording the assumption as inferred
  // evidence keeps it honest rather than presenting it as observed fact.
  const method = "POST";

  const id = canonicalServiceId({
    resourceUrl,
    method,
    protocol: "x402",
    network: primary?.network,
    payTo: primary?.payTo,
  });

  context.evidence.observe("resource", resourceUrl, "sdk", sourceRef);
  if (upstreamIndex !== undefined) {
    context.evidence.observe("upstream_index", upstreamIndex, "sdk", sourceRef);
  }
  if (primary?.price?.atomic !== undefined) {
    context.evidence.observe("price_atomic", primary.price.atomic, "sdk", sourceRef);
  }
  context.evidence.infer("method", method, "sdk", sourceRef);

  const tags = ["piprail", ...(upstreamIndex === undefined ? [] : [`index:${upstreamIndex}`])];

  return {
    id,
    kind: "service",
    sources: [{ source: "piprail", externalId: resourceUrl, observedAt, sourceUrl: sourceRef }],
    name: description ?? resourceUrl,
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
    tags,
    evidence: context.evidence.records(),
    actionability: modeAServiceActionability({
      canQuote: primary?.price !== undefined,
      canPreparePurchase: primary !== undefined,
    }),
  };
}

export class PipRailAdapter implements CommerceAdapter {
  public readonly id = "piprail" as const;

  public constructor(
    private readonly clientFactory: PipRailClientFactory = defaultPipRailClientFactory,
  ) {}

  public capabilities(): AdapterCapabilities {
    return capabilities({
      discoverServices: true,
      inspect: true,
      quote: true,
      // Preparation only. Actual payment fails closed with WALLET_REQUIRED.
      preparePurchase: true,
      preparePublish: true,
      walletless: true,
      notes: [
        "constructed with no private key; PIPRAIL_PRIVATE_KEY is never read or set",
        "uses only discover() and quote()",
        "planPayment/canAfford presuppose a wallet and are mapped to WALLET_REQUIRED",
        "register/claimDomain/verifyDomain are external writes and are never called",
      ],
    });
  }

  public async health(context?: AdapterContext): Promise<ProbeResult> {
    const checkedAt = context?.clock() ?? new Date().toISOString();
    const started = Date.now();
    try {
      const client = await this.clientFactory();
      const raw = await client.discover({ network: "any" });
      const resources = asResourceArray(raw);
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `walletless discovery reachable; ${String(resources.length)} resource(s)`,
      };
    } catch (error) {
      const typed = error instanceof CommerceError ? error : null;
      return {
        platform: this.id,
        status: typed?.code === "ADAPTER_DISABLED" ? "degraded" : "unreachable",
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
    const client = await this.clientFactory();
    // 'any' searches every chain; a caller-supplied CAIP-2 id narrows it.
    const network = query.network ?? "any";
    const raw = await client.discover({ network });
    const resources = asResourceArray(raw);

    const out: ServiceCandidate[] = [];
    for (const entry of resources) {
      if (entry === null || typeof entry !== "object") continue;
      const candidate = normalizePipRailResource(entry, context, "piprail:discover");
      if (candidate !== null) out.push(candidate);
      if (query.limit !== undefined && out.length >= query.limit) break;
    }
    return out;
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    const all = await this.discoverServices({}, context);
    const wanted = (() => {
      try {
        return normalizeResourceUrl(externalId);
      } catch {
        return externalId;
      }
    })();
    const match = all.find((s) => s.resourceUrl === wanted || s.id === externalId);
    if (match === undefined) {
      throw new CommerceError("NOT_FOUND", `no PipRail resource matched ${externalId}`);
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
      throw new CommerceError("NOT_FOUND", `no quotable PipRail resource for ${externalId}`);
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

  /**
   * Returns the facts a PaymentIntent needs and states the wallet requirement.
   *
   * Deliberately does NOT call planPayment: that method inspects a wallet's own
   * balances, so calling it would presuppose the wallet this control plane
   * refuses to have.
   */
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
      walletRequired: true,
      walletPresent: false,
      blockedReason: "WALLET_REQUIRED",
      settlementNote:
        "settling this resource through PipRail would require a signer (PIPRAIL_PRIVATE_KEY) and " +
        "live value movement. No wallet exists, no key is read, and both activation gates are off.",
      planPaymentCalled: false,
    };
  }

  /**
   * Builds registration metadata only.
   *
   * The PipRail client's register method would list an endpoint on the open 402
   * Index without a wallet or signature. That is still an external write, so it
   * is not performed here.
   *
   * This comment deliberately avoids the literal call syntax: the security test
   * greps this file for paying/registering call sites, so keeping prose free of
   * that syntax lets the grep stay strict rather than being softened to pass.
   */
  public async preparePublish(
    manifest: PublicationManifest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    void context;
    return {
      platform: this.id,
      target: "piprail/402index",
      product: manifest.product,
      version: manifest.version,
      resource: manifest.resourceUrl,
      method: manifest.method,
      network: manifest.network,
      price: manifest.price,
      description: manifest.description,
      metadataPrepared: true,
      registrationPerformed: false,
      registrationNote:
        "PipRail can register an endpoint on the open 402 Index walletlessly and without a " +
        "signature, and would return visibility=pending-review. That is an EXTERNAL_WRITE, so it " +
        "is prepared but not performed in Mode A.",
    };
  }
}
