/**
 * The canonical adapter contract.
 *
 * An adapter is a thin translator: platform payload in, canonical model out. It
 * is deliberately given a narrow context containing no wallet, signer, key,
 * account or credential. That is the structural reason an adapter cannot pay for
 * anything, regardless of what its upstream SDK happens to expose.
 */
import type { CommerceConfig } from "../config.js";
import type { AdapterCapabilities } from "../core/capabilities.js";
import type {
  InspectionResult,
  PlatformId,
  ProbeResult,
  Quote,
  ServiceCandidate,
  WorkCandidate,
} from "../core/models.js";
import type { EvidenceCollector } from "../evidence/capture.js";
import type { SafeFetch } from "../network/safe-fetch.js";

export interface ServiceQuery {
  readonly q?: string | undefined;
  readonly network?: string | undefined;
  readonly protocol?: string | undefined;
  /** Hard filter, not a ranking penalty: a known price above this is excluded. */
  readonly maxUsdPrice?: string | undefined;
  readonly limit?: number | undefined;
}

export interface WorkQuery {
  readonly q?: string | undefined;
  readonly network?: string | undefined;
  readonly minReward?: string | undefined;
  readonly limit?: number | undefined;
}

export interface PublicationManifest {
  readonly product: string;
  readonly version: string;
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network: string;
  readonly price: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Everything an adapter is allowed to touch.
 *
 * Note what is absent: no wallet, no signer, no account, no credential store,
 * no raw `fetch`, no `child_process`, no filesystem handle.
 */
export interface AdapterContext {
  /** The shared SSRF-safe HTTP client. The only sanctioned network egress. */
  readonly fetch: SafeFetch;
  /** Per-invocation evidence collector enforcing provenance rules. */
  readonly evidence: EvidenceCollector;
  /** Injectable clock so fixtures hash deterministically. */
  readonly clock: () => string;
  /** Aborted when the adapter budget is exhausted. */
  readonly signal: AbortSignal;
  /** Read-only config subset. */
  readonly config: CommerceConfig;
}

/**
 * Preparation-only outputs. Each carries the policy decision that blocked the
 * corresponding live action, so a caller receives proof of the block rather than
 * a silent no-op.
 */
export interface PreparedIntentRef {
  readonly id: string;
  readonly kind: "payment" | "claim" | "publish";
  readonly hash: string;
}

export interface CommerceAdapter {
  readonly id: PlatformId;
  capabilities(): AdapterCapabilities;
  health(context?: AdapterContext): Promise<ProbeResult>;
  discoverServices?(query: ServiceQuery, context: AdapterContext): Promise<ServiceCandidate[]>;
  discoverWork?(query: WorkQuery, context: AdapterContext): Promise<WorkCandidate[]>;
  inspect?(externalId: string, context: AdapterContext): Promise<InspectionResult>;
  quote?(externalId: string, context: AdapterContext): Promise<Quote>;
  /**
   * Returns the platform-specific facts needed to build a PaymentIntent.
   * It must never perform, sign or settle a payment.
   */
  preparePurchase?(externalId: string, context: AdapterContext): Promise<Record<string, unknown>>;
  /** Returns claim preparation facts. Must never call a claim/submit endpoint. */
  prepareClaim?(externalId: string, context: AdapterContext): Promise<Record<string, unknown>>;
  /** Returns publication preparation facts. Must never register or publish. */
  preparePublish?(
    manifest: PublicationManifest,
    context: AdapterContext,
  ): Promise<Record<string, unknown>>;
}
