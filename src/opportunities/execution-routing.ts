import type { OpportunityEvaluation } from "./evaluation.js";
import type { RankedOpportunity } from "./ranking.js";

export const OPPORTUNITY_EXECUTION_DECISIONS = [
  "agent_direct",
  "human_fulfillment",
  "hybrid",
  "manual_review",
  "watch",
  "reject",
] as const;
export type OpportunityExecutionDecision = (typeof OPPORTUNITY_EXECUTION_DECISIONS)[number];

export const HUMAN_FULFILLMENT_KINDS = ["remote", "physical"] as const;
export type HumanFulfillmentKind = (typeof HUMAN_FULFILLMENT_KINDS)[number];

export const HUMAN_COMMERCIAL_READINESS = [
  "economic_case_present",
  "needs_total_payout",
  "needs_worker_quote",
  "needs_margin_review",
  "nonpositive_margin",
] as const;
export type HumanCommercialReadiness = (typeof HUMAN_COMMERCIAL_READINESS)[number];

type MoneyRange = NonNullable<OpportunityEvaluation["economics"]["payout"]>;

export interface HumanFulfillmentQualityPolicy {
  readonly taskBriefRequired: true;
  readonly acceptanceCriteriaRequired: true;
  readonly attemptEvidenceRequired: true;
  readonly completionReviewRequired: true;
  readonly fullCompensationTiming: "after_acceptance";
  readonly goodFaithAttemptCompensation: "contract_defined_partial_after_review";
  readonly noEffortOrFraudCompensation: "none_after_review";
  readonly suspiciousCaseRequiresReview: true;
}

export interface HumanFulfillmentPlan {
  readonly mode: "analysis_only";
  readonly kind: HumanFulfillmentKind;
  readonly externalMutationAllowed: false;
  readonly workerQuoteRequired: true;
  readonly compensationAuthorizationRequired: true;
  readonly platformRulesVerificationRequired: true;
  readonly physicalSafetyReviewRequired: boolean;
  readonly commercialReadiness: HumanCommercialReadiness;
  readonly estimatedWorkerCostUsd: MoneyRange | null;
  readonly qualityPolicy: HumanFulfillmentQualityPolicy;
}

export interface OpportunityExecutionPlan {
  readonly opportunityId: string;
  readonly score: number;
  readonly priorityBand: RankedOpportunity["priorityBand"];
  readonly operatorAction: RankedOpportunity["operatorAction"];
  readonly sourceExecutionRoute: OpportunityEvaluation["executionRoute"];
  readonly decision: OpportunityExecutionDecision;
  readonly economics: OpportunityEvaluation["economics"];
  readonly humanFulfillment: HumanFulfillmentPlan | null;
  readonly reasons: readonly string[];
}

const HUMAN_QUALITY_POLICY: HumanFulfillmentQualityPolicy = Object.freeze({
  taskBriefRequired: true,
  acceptanceCriteriaRequired: true,
  attemptEvidenceRequired: true,
  completionReviewRequired: true,
  fullCompensationTiming: "after_acceptance",
  goodFaithAttemptCompensation: "contract_defined_partial_after_review",
  noEffortOrFraudCompensation: "none_after_review",
  suspiciousCaseRequiresReview: true,
});

function commercialReadiness(evaluation: OpportunityEvaluation): HumanCommercialReadiness {
  if (evaluation.economics.payout === null) return "needs_total_payout";
  if (evaluation.economics.executionCost === null) return "needs_worker_quote";
  if (evaluation.economics.margin === null) return "needs_margin_review";
  if (evaluation.economics.margin.minUsd <= 0) return "nonpositive_margin";
  return "economic_case_present";
}

function humanKind(evaluation: OpportunityEvaluation): HumanFulfillmentKind | undefined {
  if (evaluation.executionRoute === "human_remote") {
    if (!evaluation.capabilities.humanRequired || evaluation.capabilities.physicalPresence) return undefined;
    return "remote";
  }
  if (evaluation.executionRoute === "human_physical") {
    if (!evaluation.capabilities.humanRequired || !evaluation.capabilities.physicalPresence) return undefined;
    return "physical";
  }
  if (evaluation.executionRoute === "hybrid") {
    if (!evaluation.capabilities.humanRequired) return undefined;
    return evaluation.capabilities.physicalPresence ? "physical" : "remote";
  }
  return undefined;
}

function humanPlan(evaluation: OpportunityEvaluation, kind: HumanFulfillmentKind): HumanFulfillmentPlan {
  return Object.freeze({
    mode: "analysis_only" as const,
    kind,
    externalMutationAllowed: false as const,
    workerQuoteRequired: true as const,
    compensationAuthorizationRequired: true as const,
    platformRulesVerificationRequired: true as const,
    physicalSafetyReviewRequired: kind === "physical",
    commercialReadiness: commercialReadiness(evaluation),
    estimatedWorkerCostUsd: evaluation.economics.executionCost,
    qualityPolicy: HUMAN_QUALITY_POLICY,
  });
}

function invalidRouteReason(evaluation: OpportunityEvaluation): string | undefined {
  switch (evaluation.executionRoute) {
    case "ai_direct":
      if (!evaluation.capabilities.aiCanComplete) return "ai_direct route conflicts with aiCanComplete=false";
      if (evaluation.capabilities.humanRequired) return "ai_direct route conflicts with humanRequired=true";
      if (evaluation.capabilities.physicalPresence) return "ai_direct route conflicts with physicalPresence=true";
      return undefined;
    case "human_remote":
      if (!evaluation.capabilities.humanRequired) return "human_remote route conflicts with humanRequired=false";
      if (evaluation.capabilities.physicalPresence) return "human_remote route conflicts with physicalPresence=true";
      return undefined;
    case "human_physical":
      if (!evaluation.capabilities.humanRequired) return "human_physical route conflicts with humanRequired=false";
      if (!evaluation.capabilities.physicalPresence) return "human_physical route conflicts with physicalPresence=false";
      return undefined;
    case "hybrid":
      if (!evaluation.capabilities.humanRequired) return "hybrid route requires a human component";
      return undefined;
    case "manual":
    case "unknown":
      return undefined;
  }
}

/**
 * Convert a ranked, already-evaluated opportunity into an execution decision.
 *
 * This layer is deliberately offline and non-mutating. It decides whether work
 * belongs on an agent, human, hybrid, or manual path and emits the minimum
 * human-fulfillment controls needed for a later recruiter/worker adapter. It
 * does not post a job, contact a worker, promise compensation, accept work, or
 * move money.
 */
export function buildOpportunityExecutionPlan(entry: RankedOpportunity): OpportunityExecutionPlan {
  const evaluation = entry.evaluationRecord.evaluation;
  const reasons: string[] = [...entry.routingReasons];

  if (entry.operatorAction === "reject") {
    reasons.push("rejected opportunities cannot enter execution");
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "reject" as const,
      economics: evaluation.economics,
      humanFulfillment: null,
      reasons: Object.freeze(reasons),
    });
  }

  if (entry.operatorAction === "watch") {
    reasons.push("watch opportunities remain outside execution until re-evaluated");
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "watch" as const,
      economics: evaluation.economics,
      humanFulfillment: null,
      reasons: Object.freeze(reasons),
    });
  }

  if (entry.operatorAction === "manual_review") {
    reasons.push("ranking gate requires manual review before execution planning");
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "manual_review" as const,
      economics: evaluation.economics,
      humanFulfillment: null,
      reasons: Object.freeze(reasons),
    });
  }

  const conflict = invalidRouteReason(evaluation);
  if (conflict !== undefined) {
    reasons.push(conflict);
    reasons.push("execution-route/capability conflict requires manual review rather than silent repair");
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "manual_review" as const,
      economics: evaluation.economics,
      humanFulfillment: null,
      reasons: Object.freeze(reasons),
    });
  }

  if (evaluation.executionRoute === "ai_direct") {
    reasons.push("validated pursue candidate is suitable for direct agent/AI execution");
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "agent_direct" as const,
      economics: evaluation.economics,
      humanFulfillment: null,
      reasons: Object.freeze(reasons),
    });
  }

  if (evaluation.executionRoute === "human_remote" || evaluation.executionRoute === "human_physical") {
    const kind = humanKind(evaluation);
    if (kind === undefined) throw new Error("unreachable human route after validation");
    const plan = humanPlan(evaluation, kind);
    reasons.push(`validated pursue candidate requires ${kind} human fulfillment`);
    if (plan.commercialReadiness !== "economic_case_present") {
      reasons.push(`human fulfillment commercial gate: ${plan.commercialReadiness}`);
    }
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "human_fulfillment" as const,
      economics: evaluation.economics,
      humanFulfillment: plan,
      reasons: Object.freeze(reasons),
    });
  }

  if (evaluation.executionRoute === "hybrid") {
    const kind = humanKind(evaluation);
    if (kind === undefined) throw new Error("unreachable hybrid route after validation");
    const plan = humanPlan(evaluation, kind);
    reasons.push(`validated pursue candidate requires hybrid agent + ${kind} human execution`);
    if (plan.commercialReadiness !== "economic_case_present") {
      reasons.push(`human fulfillment commercial gate: ${plan.commercialReadiness}`);
    }
    return Object.freeze({
      opportunityId: entry.opportunity.id,
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      sourceExecutionRoute: evaluation.executionRoute,
      decision: "hybrid" as const,
      economics: evaluation.economics,
      humanFulfillment: plan,
      reasons: Object.freeze(reasons),
    });
  }

  reasons.push(`execution route ${evaluation.executionRoute} requires manual resolution`);
  return Object.freeze({
    opportunityId: entry.opportunity.id,
    score: entry.score,
    priorityBand: entry.priorityBand,
    operatorAction: entry.operatorAction,
    sourceExecutionRoute: evaluation.executionRoute,
    decision: "manual_review" as const,
    economics: evaluation.economics,
    humanFulfillment: null,
    reasons: Object.freeze(reasons),
  });
}

export function buildOpportunityExecutionPlans(
  ranked: readonly RankedOpportunity[],
): readonly OpportunityExecutionPlan[] {
  return Object.freeze(ranked.map((entry) => buildOpportunityExecutionPlan(entry)));
}
