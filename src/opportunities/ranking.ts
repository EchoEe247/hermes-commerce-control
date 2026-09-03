import {
  buildOpportunityEvaluationPacket,
  type OpportunityEvaluation,
} from "./evaluation.js";
import { buildPreparedOpportunityEvaluation } from "./evaluation-queue.js";
import type {
  OpportunityEvaluationResultStore,
  PersistedOpportunityEvaluation,
} from "./evaluation-results.js";
import type { OpportunityCandidate } from "./models.js";
import type { OpportunityStore } from "./store.js";
import {
  triageOpportunity,
  type OpportunityTriageProfile,
  type OpportunityTriageResult,
} from "./triage.js";

type OpportunityExecutionRoute = OpportunityEvaluation["executionRoute"];

export const OPPORTUNITY_OPERATOR_ACTIONS = [
  "review_for_pursuit",
  "manual_review",
  "watch",
  "reject",
] as const;
export type OpportunityOperatorAction = (typeof OPPORTUNITY_OPERATOR_ACTIONS)[number];

export const OPPORTUNITY_PRIORITY_BANDS = ["high", "medium", "low", "blocked"] as const;
export type OpportunityPriorityBand = (typeof OPPORTUNITY_PRIORITY_BANDS)[number];
export type OpportunityEvaluationFreshness = "current" | "stale_rejected";
export const DEFAULT_RANKING_MAX_AGE_HOURS = 168;

export interface OpportunityRankComponents {
  readonly triage: number;
  readonly recommendation: number;
  readonly risk: number;
  readonly confidence: number;
  readonly economics: number;
  readonly executionRoute: number;
  readonly blockers: number;
}

export interface RankedOpportunity {
  readonly opportunity: OpportunityCandidate;
  readonly triage: OpportunityTriageResult;
  readonly evaluationRecord: PersistedOpportunityEvaluation;
  readonly evaluationFreshness: OpportunityEvaluationFreshness;
  readonly currentRequestId: string;
  readonly score: number;
  readonly priorityBand: OpportunityPriorityBand;
  readonly operatorAction: OpportunityOperatorAction;
  readonly executionRoute: OpportunityExecutionRoute;
  readonly components: OpportunityRankComponents;
  readonly routingReasons: readonly string[];
}

export interface OpportunityRankingOptions {
  /** If supplied, only evaluations from this exact evaluator ID are considered. */
  readonly evaluatorId?: string | undefined;
  readonly actions?: readonly OpportunityOperatorAction[] | undefined;
  readonly minimumScore?: number | undefined;
  readonly limit?: number | undefined;
  readonly scanLimit?: number | undefined;
  /** Maximum age for non-rejected opportunity/evaluation state. 0 disables age filtering. */
  readonly maxAgeHours?: number | undefined;
  /** Deterministic clock injection for tests/replay. Defaults to current wall clock. */
  readonly asOf?: string | undefined;
}

const RECOMMENDATION_SCORE: Readonly<Record<OpportunityEvaluation["recommendation"], number>> = {
  pursue: 35,
  manual_review: 15,
  watch: 5,
  reject: -35,
};

const RISK_SCORE: Readonly<Record<OpportunityEvaluation["risk"], number>> = {
  low: 10,
  medium: 0,
  high: -20,
};

const ROUTE_SCORE: Readonly<Record<OpportunityExecutionRoute, number>> = {
  ai_direct: 8,
  human_remote: 5,
  human_physical: 3,
  hybrid: 4,
  manual: 0,
  unknown: -4,
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(selected)));
}

function boundedScore(value: number | undefined): number {
  const selected = value ?? 0;
  if (!Number.isFinite(selected)) return 0;
  return Math.max(0, Math.min(100, selected));
}

function boundedAgeHours(value: number | undefined): number {
  const selected = value ?? DEFAULT_RANKING_MAX_AGE_HOURS;
  if (!Number.isFinite(selected) || selected < 0) return DEFAULT_RANKING_MAX_AGE_HOURS;
  return Math.min(24 * 365, selected);
}

function amountSignal(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1_000) return 10;
  if (value >= 500) return 8;
  if (value >= 100) return 6;
  if (value >= 25) return 3;
  return 1;
}

function economicsScore(evaluation: OpportunityEvaluation): number {
  const payout = evaluation.economics.payout?.minUsd;
  const margin = evaluation.economics.margin?.minUsd;
  const payoutSignal = amountSignal(payout);
  const marginSignal = amountSignal(margin);
  // Margin matters more than gross payout, but keep economics bounded because
  // both cost/margin values may be model-inferred rather than observed facts.
  return Math.min(15, Math.round(payoutSignal * 0.4 + marginSignal));
}

function scoreComponents(
  triage: OpportunityTriageResult,
  evaluation: OpportunityEvaluation,
): OpportunityRankComponents {
  return Object.freeze({
    triage: Math.round(triage.score * 0.35),
    recommendation: RECOMMENDATION_SCORE[evaluation.recommendation],
    risk: RISK_SCORE[evaluation.risk],
    confidence: Math.round((evaluation.confidence - 0.5) * 20),
    economics: economicsScore(evaluation),
    executionRoute: ROUTE_SCORE[evaluation.executionRoute],
    blockers: -Math.min(15, evaluation.blockers.length * 5),
  });
}

function sumComponents(components: OpportunityRankComponents): number {
  return (
    components.triage +
    components.recommendation +
    components.risk +
    components.confidence +
    components.economics +
    components.executionRoute +
    components.blockers
  );
}

function deriveOperatorAction(
  triage: OpportunityTriageResult,
  evaluation: OpportunityEvaluation,
): { readonly action: OpportunityOperatorAction; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (triage.decision === "reject") {
    reasons.push("current deterministic triage rejects this opportunity");
    return Object.freeze({ action: "reject" as const, reasons: Object.freeze(reasons) });
  }
  if (evaluation.recommendation === "reject") {
    reasons.push("model evaluation recommends rejection");
    return Object.freeze({ action: "reject" as const, reasons: Object.freeze(reasons) });
  }
  if (evaluation.recommendation === "watch") {
    reasons.push("model evaluation recommends watching rather than pursuing now");
    return Object.freeze({ action: "watch" as const, reasons: Object.freeze(reasons) });
  }
  if (evaluation.recommendation === "manual_review") {
    reasons.push("model evaluation explicitly requires manual review");
    return Object.freeze({ action: "manual_review" as const, reasons: Object.freeze(reasons) });
  }
  if (evaluation.risk === "high") {
    reasons.push("high-risk pursue recommendation requires manual review");
    return Object.freeze({ action: "manual_review" as const, reasons: Object.freeze(reasons) });
  }
  if (evaluation.blockers.length > 0) {
    reasons.push("unresolved blocker(s) require manual review before pursuit");
    return Object.freeze({ action: "manual_review" as const, reasons: Object.freeze(reasons) });
  }
  reasons.push("pursue recommendation has no high-risk or blocker gate");
  return Object.freeze({ action: "review_for_pursuit" as const, reasons: Object.freeze(reasons) });
}

function priorityBand(action: OpportunityOperatorAction, score: number): OpportunityPriorityBand {
  if (action === "reject") return "blocked";
  if (action === "watch") return "low";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

export function rankOpportunity(
  opportunity: OpportunityCandidate,
  triage: OpportunityTriageResult,
  evaluationRecord: PersistedOpportunityEvaluation,
  currentRequestId: string,
): RankedOpportunity {
  const evaluation = evaluationRecord.evaluation;
  const components = scoreComponents(triage, evaluation);
  const routing = deriveOperatorAction(triage, evaluation);
  let score = clampScore(sumComponents(components));
  if (routing.action === "reject") score = 0;
  const band = priorityBand(routing.action, score);
  const freshness: OpportunityEvaluationFreshness =
    evaluationRecord.requestId === currentRequestId ? "current" : "stale_rejected";
  return Object.freeze({
    opportunity,
    triage,
    evaluationRecord,
    evaluationFreshness: freshness,
    currentRequestId,
    score,
    priorityBand: band,
    operatorAction: routing.action,
    executionRoute: evaluation.executionRoute,
    components,
    routingReasons: routing.reasons,
  });
}

function evaluatedAtMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function firstValidTimestamp(...values: readonly (string | undefined)[]): number | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function ageHours(asOfMillis: number, timestampMillis: number | undefined): number | undefined {
  if (timestampMillis === undefined) return undefined;
  return Math.max(0, asOfMillis - timestampMillis) / 3_600_000;
}

function isNewerEvaluation(
  candidate: PersistedOpportunityEvaluation,
  current: PersistedOpportunityEvaluation,
): boolean {
  const candidateTime = evaluatedAtMillis(candidate.evaluatedAt);
  const currentTime = evaluatedAtMillis(current.evaluatedAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const byEvaluator = candidate.evaluatorId.localeCompare(current.evaluatorId);
  if (byEvaluator !== 0) return byEvaluator < 0;
  return candidate.requestId.localeCompare(current.requestId) < 0;
}

function selectNewest(
  rows: readonly PersistedOpportunityEvaluation[],
  evaluatorId: string | undefined,
  requestId?: string,
): PersistedOpportunityEvaluation | undefined {
  let selected: PersistedOpportunityEvaluation | undefined;
  for (const row of rows) {
    if (evaluatorId !== undefined && evaluatorId !== "" && row.evaluatorId !== evaluatorId) continue;
    if (requestId !== undefined && row.requestId !== requestId) continue;
    if (selected === undefined || isNewerEvaluation(row, selected)) selected = row;
  }
  return selected;
}

/**
 * Build a ranked, analysis-only queue from durable opportunity + evaluation state.
 *
 * No model or network call occurs here. A non-rejected row must have an evaluation
 * for the exact current packet/request ID, so changing deterministic triage cannot
 * silently reuse stale model reasoning. Current deterministic rejects may surface
 * with an older evaluation only for provenance; they remain forced to score 0.
 * Non-rejected rows also default to a seven-day age window so obsolete listings or
 * evaluations cannot remain pursuit candidates indefinitely.
 */
export async function rankStoredOpportunities(
  opportunityStore: OpportunityStore,
  evaluationStore: OpportunityEvaluationResultStore,
  profile: OpportunityTriageProfile = {},
  options: OpportunityRankingOptions = {},
): Promise<readonly RankedOpportunity[]> {
  const scanLimit = boundedInteger(options.scanLimit, 1_000, 1, 10_000);
  const outputLimit = boundedInteger(options.limit, 50, 0, scanLimit);
  if (outputLimit === 0) return Object.freeze([]);

  const [opportunities, evaluations] = await Promise.all([
    opportunityStore.list(scanLimit),
    evaluationStore.list(),
  ]);
  const evaluationsByOpportunity = new Map<string, PersistedOpportunityEvaluation[]>();
  for (const row of evaluations) {
    const rows = evaluationsByOpportunity.get(row.opportunityId) ?? [];
    rows.push(row);
    evaluationsByOpportunity.set(row.opportunityId, rows);
  }

  const minimumScore = boundedScore(options.minimumScore);
  const actionFilter =
    options.actions === undefined || options.actions.length === 0
      ? undefined
      : new Set(options.actions);
  const evaluatorId = options.evaluatorId?.trim();
  const maxAgeHours = boundedAgeHours(options.maxAgeHours);
  const asOfMillis = options.asOf === undefined ? Date.now() : Date.parse(options.asOf);
  if (!Number.isFinite(asOfMillis)) throw new Error("ranking asOf must be a valid timestamp");
  const ranked: RankedOpportunity[] = [];

  for (const opportunity of opportunities) {
    const triage = triageOpportunity(opportunity, profile);
    const packet = buildOpportunityEvaluationPacket(opportunity, triage);
    const currentRequestId = buildPreparedOpportunityEvaluation(packet).requestId;
    const rows = evaluationsByOpportunity.get(opportunity.id) ?? [];
    const currentEvaluation = selectNewest(rows, evaluatorId, currentRequestId);
    const evaluation =
      currentEvaluation ??
      (triage.decision === "reject" ? selectNewest(rows, evaluatorId) : undefined);
    if (evaluation === undefined) continue;

    if (triage.decision !== "reject" && maxAgeHours > 0) {
      const opportunityAge = ageHours(
        asOfMillis,
        firstValidTimestamp(opportunity.postedAt, opportunity.observedAt),
      );
      const evaluationAge = ageHours(asOfMillis, evaluatedAtMillis(evaluation.evaluatedAt));
      if (
        opportunityAge === undefined ||
        evaluationAge === undefined ||
        opportunityAge > maxAgeHours ||
        evaluationAge > maxAgeHours
      ) {
        continue;
      }
    }

    const entry = rankOpportunity(opportunity, triage, evaluation, currentRequestId);
    if (entry.score < minimumScore) continue;
    if (actionFilter !== undefined && !actionFilter.has(entry.operatorAction)) continue;
    ranked.push(entry);
  }

  ranked.sort((a, b) => {
    const score = b.score - a.score;
    if (score !== 0) return score;
    const time = evaluatedAtMillis(b.evaluationRecord.evaluatedAt) - evaluatedAtMillis(a.evaluationRecord.evaluatedAt);
    if (time !== 0) return time;
    return a.opportunity.id.localeCompare(b.opportunity.id);
  });

  return Object.freeze(ranked.slice(0, outputLimit));
}
