/**
 * Deterministic work ranking.
 *
 * Weights are fixed by the design spec and total 100:
 *
 *   funding proof          25
 *   verification quality   20
 *   reward attractiveness  20
 *   deadline feasibility   15
 *   requirement fit        10
 *   source confidence      10
 *
 * Two rules encode the spec's judgement calls:
 *
 *  - Funding proof scores on the EVIDENCE CLASS, not on the platform's assertion.
 *    A bounty a marketplace merely says is funded scores lower than one backed by
 *    authoritative settlement proof. This is what stops a confident-sounding
 *    upstream from outranking a genuinely verifiable one.
 *  - A deterministic / verifier-ready check outranks an opaque AI oracle when
 *    everything else is equal, because a solver can predict whether it will pass.
 *
 * Closed and unfunded work is excluded upstream in aggregate/work.ts rather than
 * ranked low: work nobody can be paid for is not an opportunity.
 */
import { toRankingNumber } from "../core/money.js";
import type { EvidenceClass, VerifierType, WorkCandidate } from "../core/models.js";

export const WORK_WEIGHTS = Object.freeze({
  fundingProof: 25,
  verificationQuality: 20,
  rewardAttractiveness: 20,
  deadlineFeasibility: 15,
  requirementFit: 10,
  sourceConfidence: 10,
});

/** Neutral fraction applied when a signal is genuinely unknown. */
export const NEUTRAL_FRACTION = 0.5;

export interface WorkScoreBreakdown {
  readonly fundingProof: number;
  readonly verificationQuality: number;
  readonly rewardAttractiveness: number;
  readonly deadlineFeasibility: number;
  readonly requirementFit: number;
  readonly sourceConfidence: number;
  readonly total: number;
  readonly neutralComponents: readonly string[];
}

export interface RankedWork {
  readonly work: WorkCandidate;
  readonly score: number;
  readonly breakdown: WorkScoreBreakdown;
}

export interface WorkRankOptions {
  /** Hard filter: work rewarding less than this is excluded. */
  readonly minReward?: string | undefined;
  /** Capabilities the solver has, used for requirement fit. */
  readonly capabilities?: readonly string[] | undefined;
  /** Reference time for deadline feasibility. Injected for deterministic tests. */
  readonly now?: string | undefined;
  /** Reward at or above which attractiveness saturates. Defaults to 25 USD. */
  readonly rewardSaturation?: string | undefined;
}

/**
 * Funding-proof fraction by evidence class.
 *
 * `verified` is the only class backed by authoritative proof, so it alone earns
 * full marks. `observed` is the platform's own claim.
 */
const FUNDING_EVIDENCE_FRACTION: Readonly<Record<EvidenceClass, number>> = Object.freeze({
  verified: 1,
  observed: 0.6,
  inferred: 0.35,
  tentative: 0.15,
});

/** Funding-state multiplier. A claimed bounty is contested. */
const FUNDING_STATE_FRACTION: Readonly<Record<string, number>> = Object.freeze({
  funded: 1,
  claimed: 0.5,
  submitted: 0.3,
  advertised: 0.2,
  unfunded: 0,
  settled: 0,
  refunded: 0,
  unknown: 0.2,
});

/**
 * Verification-quality fraction.
 *
 * Deterministic ranks highest because its outcome is predictable before the work
 * is done. An AI oracle is opaque: a solver cannot know in advance what will pass.
 */
const VERIFIER_FRACTION: Readonly<Record<VerifierType, number>> = Object.freeze({
  deterministic: 1,
  hybrid: 0.7,
  operator: 0.5,
  ai_oracle: 0.4,
  unknown: 0.2,
});

const SOURCE_CONFIDENCE: Readonly<Record<string, number>> = Object.freeze({
  agent_bounties: 0.9,
  bountybook: 0.65,
  the402: 0.5,
  cdp_bazaar: 0.5,
  agent402: 0.5,
  piprail: 0.5,
  paysh: 0.5,
});

/** Deadline horizon: further out than this is fully feasible. */
const COMFORTABLE_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function scoreWork(work: WorkCandidate, options: WorkRankOptions = {}): WorkScoreBreakdown {
  const neutral: string[] = [];

  // Funding proof: evidence class gated by funding state.
  const evidenceFraction = FUNDING_EVIDENCE_FRACTION[work.funding.evidence];
  const stateFraction = FUNDING_STATE_FRACTION[work.funding.state] ?? 0.2;
  const fundingProof = WORK_WEIGHTS.fundingProof * clamp01(evidenceFraction * stateFraction);

  // Verification quality.
  const verificationQuality =
    WORK_WEIGHTS.verificationQuality * VERIFIER_FRACTION[work.verification.type];
  if (work.verification.type === "unknown") neutral.push("verificationQuality");

  // Reward attractiveness, log-scaled so 1 -> 5 USD matters more than 100 -> 105.
  const saturation = toRankingNumber(options.rewardSaturation ?? "25");
  const rewardUsd = work.reward.usd ?? work.reward.amount;
  let rewardFraction: number;
  const reward = toRankingNumber(rewardUsd);
  if (!Number.isFinite(reward) || reward <= 0) {
    rewardFraction = 0;
  } else {
    rewardFraction = clamp01(Math.log10(1 + reward) / Math.log10(1 + Math.max(1, saturation)));
  }
  const rewardAttractiveness = WORK_WEIGHTS.rewardAttractiveness * rewardFraction;

  // Deadline feasibility. No deadline is *good*, not unknown: nothing is forcing
  // the work to be rushed, so it earns full marks rather than a neutral score.
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  let deadlineFraction: number;
  if (work.deadline === undefined) {
    deadlineFraction = 1;
  } else {
    const deadlineMs = Date.parse(work.deadline);
    if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) {
      deadlineFraction = NEUTRAL_FRACTION;
      neutral.push("deadlineFeasibility");
    } else {
      const remaining = deadlineMs - nowMs;
      // Already expired is unusable.
      deadlineFraction = remaining <= 0 ? 0 : clamp01(remaining / COMFORTABLE_DEADLINE_MS);
    }
  }
  const deadlineFeasibility = WORK_WEIGHTS.deadlineFeasibility * deadlineFraction;

  // Requirement fit. Without a declared capability set this is genuinely
  // unknown, so it takes the neutral contribution.
  let requirementFraction: number;
  const capabilities = options.capabilities;
  if (capabilities === undefined || capabilities.length === 0) {
    requirementFraction = NEUTRAL_FRACTION;
    neutral.push("requirementFit");
  } else if (work.requirements.length === 0) {
    // Nothing demanded: trivially a fit.
    requirementFraction = 1;
  } else {
    const haystack = `${work.title}\n${work.description ?? ""}\n${work.requirements.join("\n")}`.toLowerCase();
    const matches = capabilities.filter((c) => haystack.includes(c.trim().toLowerCase())).length;
    requirementFraction = clamp01(matches / capabilities.length);
  }
  const requirementFit = WORK_WEIGHTS.requirementFit * requirementFraction;

  // Source confidence.
  const sourceConfidence =
    WORK_WEIGHTS.sourceConfidence * clamp01(SOURCE_CONFIDENCE[work.source] ?? NEUTRAL_FRACTION);

  const total =
    fundingProof +
    verificationQuality +
    rewardAttractiveness +
    deadlineFeasibility +
    requirementFit +
    sourceConfidence;

  return Object.freeze({
    fundingProof: round4(fundingProof),
    verificationQuality: round4(verificationQuality),
    rewardAttractiveness: round4(rewardAttractiveness),
    deadlineFeasibility: round4(deadlineFeasibility),
    requirementFit: round4(requirementFit),
    sourceConfidence: round4(sourceConfidence),
    total: round4(total),
    neutralComponents: Object.freeze([...neutral].sort()),
  });
}

/**
 * Applies hard filters then ranks.
 *
 * Ties break on canonical ID lexical order, giving a total, stable ordering.
 */
export function rankWork(
  work: readonly WorkCandidate[],
  options: WorkRankOptions = {},
): RankedWork[] {
  const filtered = work.filter((candidate) => {
    if (options.minReward === undefined) return true;
    const reward = toRankingNumber(candidate.reward.usd ?? candidate.reward.amount);
    const minimum = toRankingNumber(options.minReward);
    return reward >= minimum;
  });

  const ranked = filtered.map((candidate) => {
    const breakdown = scoreWork(candidate, options);
    return Object.freeze({ work: candidate, score: breakdown.total, breakdown });
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.work.id < b.work.id ? -1 : a.work.id > b.work.id ? 1 : 0;
  });
  return ranked;
}
