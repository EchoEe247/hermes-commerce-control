/**
 * Canonical domain models shared by every adapter, the ranking engine, the
 * intent engine, the CLI and the MCP server.
 *
 * Adapters normalize *into* these types. Nothing downstream of an adapter ever
 * sees a platform-native shape, which is what keeps platform vocabulary from
 * leaking into Hermes' interface.
 */

export const PLATFORM_IDS = [
  "cdp_bazaar",
  "agent402",
  "piprail",
  "agent_bounties",
  "bountybook",
  "the402",
  "paysh",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const EVIDENCE_CLASSES = ["verified", "observed", "inferred", "tentative"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const SOURCE_HEALTHS = ["ok", "degraded", "unreachable", "disabled"] as const;
export type SourceHealth = (typeof SOURCE_HEALTHS)[number];

export const VERIFIER_TYPES = [
  "deterministic",
  "ai_oracle",
  "operator",
  "hybrid",
  "unknown",
] as const;
export type VerifierType = (typeof VERIFIER_TYPES)[number];

export const FUNDING_STATES = [
  "unfunded",
  "advertised",
  "funded",
  "claimed",
  "submitted",
  "settled",
  "refunded",
  "unknown",
] as const;
export type FundingState = (typeof FUNDING_STATES)[number];

export const WORK_STATUSES = ["open", "claimed", "in_review", "closed", "unknown"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const SOURCE_TYPES = [
  "http_api",
  "openapi",
  "sdk",
  "onchain",
  "local_file",
  "docs",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Where a normalized fact came from, and how much it can be trusted. */
export interface EvidenceRecord {
  readonly platform: PlatformId;
  readonly fact: string;
  readonly value: string;
  readonly classification: EvidenceClass;
  readonly sourceType: SourceType;
  readonly sourceRef: string;
  readonly capturedAt: string;
  readonly hash: string;
  readonly rawPath?: string | undefined;
}

export interface SourceObservation {
  readonly source: PlatformId;
  readonly externalId: string;
  readonly observedAt: string;
  readonly sourceUrl?: string | undefined;
}

export interface AssetRef {
  readonly address?: string | undefined;
  readonly symbol?: string | undefined;
  /** Token decimals; required to convert atomic amounts safely. */
  readonly decimals?: number | undefined;
}

/**
 * A price. `atomic` and `decimal` are authoritative strings. `usd` is only
 * populated when the asset genuinely establishes a USD value (a 6-decimal
 * USD stablecoin); it is never guessed.
 */
export interface PriceRef {
  readonly atomic?: string | undefined;
  readonly decimal?: string | undefined;
  readonly display?: string | undefined;
  readonly currency?: string | undefined;
  readonly usd?: string | undefined;
}

export interface ActivityMetrics {
  readonly calls30d?: number | undefined;
  readonly uniquePayers30d?: number | undefined;
  readonly successRate?: number | undefined;
}

/** Mode-A service actionability. Live purchase is structurally false. */
export interface ServiceActionability {
  readonly canQuote: boolean;
  readonly canPreparePurchase: boolean;
  readonly canPurchase: false;
}

/** Mode-A work actionability. Live claim and submit are structurally false. */
export interface WorkActionability {
  readonly canPrepareClaim: boolean;
  readonly canClaim: false;
  readonly canSubmit: false;
}

/**
 * Builds service actionability with the live flag pinned false.
 *
 * There is deliberately no overload that lets a caller pass `canPurchase`.
 */
export function modeAServiceActionability(input: {
  canQuote: boolean;
  canPreparePurchase: boolean;
}): ServiceActionability {
  return Object.freeze({
    canQuote: input.canQuote,
    canPreparePurchase: input.canPreparePurchase,
    canPurchase: false as const,
  });
}

/** Builds work actionability with live claim/submit pinned false. */
export function modeAWorkActionability(input: { canPrepareClaim: boolean }): WorkActionability {
  return Object.freeze({
    canPrepareClaim: input.canPrepareClaim,
    canClaim: false as const,
    canSubmit: false as const,
  });
}

export interface ServiceCandidate {
  readonly id: string;
  readonly kind: "service";
  readonly sources: readonly SourceObservation[];
  readonly name: string;
  readonly description?: string | undefined;
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network?: string | undefined;
  readonly asset?: AssetRef | undefined;
  readonly price?: PriceRef | undefined;
  readonly payTo?: string | undefined;
  readonly health: SourceHealth;
  readonly observedAt: string;
  readonly activity?: ActivityMetrics | undefined;
  readonly tags: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  readonly actionability: ServiceActionability;
}

export interface RewardRef {
  readonly amount: string;
  readonly asset: string;
  readonly network?: string | undefined;
  readonly usd?: string | undefined;
}

export interface FundingRef {
  readonly state: FundingState;
  /**
   * Evidence class for the funding claim. Only authoritative settlement proof
   * may reach "verified"; a platform simply advertising a reward is "observed".
   */
  readonly evidence: EvidenceClass;
  readonly proofRef?: string | undefined;
}

export interface VerificationRef {
  readonly type: VerifierType;
  readonly description?: string | undefined;
}

export interface WorkCandidate {
  readonly id: string;
  readonly kind: "work";
  readonly source: PlatformId;
  readonly externalId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly url?: string | undefined;
  readonly reward: RewardRef;
  readonly funding: FundingRef;
  readonly verification: VerificationRef;
  readonly deadline?: string | undefined;
  readonly requirements: readonly string[];
  readonly status: WorkStatus;
  readonly paymentProofRule?: string | undefined;
  readonly observedAt: string;
  readonly evidence: readonly EvidenceRecord[];
  readonly actionability: WorkActionability;
}

export interface ProbeResult {
  readonly platform: PlatformId;
  readonly status: SourceHealth;
  readonly checkedAt: string;
  readonly latencyMs?: number | undefined;
  readonly detail?: string | undefined;
  readonly errorCode?: string | undefined;
}

export interface Quote {
  readonly serviceId: string;
  readonly platform: PlatformId;
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network?: string | undefined;
  readonly asset?: AssetRef | undefined;
  readonly price?: PriceRef | undefined;
  readonly payTo?: string | undefined;
  readonly quotedAt: string;
  readonly evidence: readonly EvidenceRecord[];
  /** Mode A never produces an executable quote. */
  readonly executable: false;
}

export interface InspectionResult {
  readonly platform: PlatformId;
  readonly externalId: string;
  readonly inspectedAt: string;
  readonly service?: ServiceCandidate | undefined;
  readonly work?: WorkCandidate | undefined;
  readonly raw?: unknown;
  readonly evidence: readonly EvidenceRecord[];
}

/** Per-source outcome inside an aggregate response. */
export interface SourceStatus {
  readonly status: SourceHealth;
  readonly count: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface AggregateResult<T> {
  readonly sources: Readonly<Record<string, SourceStatus>>;
  readonly results: readonly T[];
}
