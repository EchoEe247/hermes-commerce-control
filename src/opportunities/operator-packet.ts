import { canonicalHash } from "../core/ids.js";
import type { RankedOpportunity } from "./ranking.js";

export const OPERATOR_PACKET_ACTIONS = ["review_for_pursuit", "manual_review"] as const;
export type OperatorPacketAction = (typeof OPERATOR_PACKET_ACTIONS)[number];

export const OPERATOR_READINESS_STATES = [
  "needs_checks",
  "needs_operator_review",
  "ready_for_operator_decision",
] as const;
export type OperatorReadinessState = (typeof OPERATOR_READINESS_STATES)[number];

export const OPERATOR_NEXT_STEPS = ["resolve_checks", "operator_review", "operator_decision"] as const;
export type OperatorNextStep = (typeof OPERATOR_NEXT_STEPS)[number];

export const EXTERNAL_ACTIONS_REQUIRING_APPROVAL = [
  "contact_counterparty",
  "claim_or_accept_work",
  "submit_work",
  "hire_worker",
  "send_or_receive_payment",
] as const;

export interface OpportunityOperatorPreparationPacket {
  readonly schemaVersion: 1;
  readonly packetId: string;
  readonly opportunity: {
    readonly id: string;
    readonly title: string;
    readonly community?: string | undefined;
    readonly url?: string | undefined;
    readonly postedAt?: string | undefined;
    readonly observedAt: string;
  };
  readonly triage: {
    readonly decision: RankedOpportunity["triage"]["decision"];
    readonly score: number;
    readonly reasons: readonly string[];
    readonly cautionFlags: readonly string[];
    readonly budget?: RankedOpportunity["triage"]["signals"]["budget"] | undefined;
  };
  readonly ranking: {
    readonly score: number;
    readonly priorityBand: RankedOpportunity["priorityBand"];
    readonly operatorAction: OperatorPacketAction;
    readonly executionRoute: RankedOpportunity["executionRoute"];
    readonly currentRequestId: string;
    readonly evaluationFreshness: RankedOpportunity["evaluationFreshness"];
    readonly evaluatorId: string;
    readonly evaluatedAt: string;
    readonly routingReasons: readonly string[];
    readonly scoreComponents: RankedOpportunity["components"];
  };
  readonly assessment: {
    readonly recommendation: RankedOpportunity["evaluationRecord"]["evaluation"]["recommendation"];
    readonly risk: RankedOpportunity["evaluationRecord"]["evaluation"]["risk"];
    readonly confidence: number;
    readonly estimatedEffortMinutes: number | null;
    readonly economics: RankedOpportunity["evaluationRecord"]["evaluation"]["economics"];
    readonly capabilities: RankedOpportunity["evaluationRecord"]["evaluation"]["capabilities"];
    readonly reasons: readonly string[];
    readonly blockers: readonly string[];
    readonly nextChecks: readonly string[];
  };
  readonly readiness: OperatorReadinessState;
  readonly nextSafeStep: OperatorNextStep;
  readonly requiredChecks: readonly string[];
  readonly deliveryConsiderations: readonly string[];
  readonly boundary: {
    readonly externalActionsAllowed: false;
    readonly requiresExplicitApprovalBefore: typeof EXTERNAL_ACTIONS_REQUIRING_APPROVAL;
  };
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized === "") continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return Object.freeze(out);
}

function deliveryConsiderations(entry: RankedOpportunity): readonly string[] {
  const evaluation = entry.evaluationRecord.evaluation;
  const out: string[] = [];
  switch (entry.executionRoute) {
    case "ai_direct":
      out.push("If explicitly approved later, confirm requirements and acceptance criteria before routing delivery to an AI-capable executor.");
      break;
    case "human_remote":
      out.push("Confirm a suitable remote human executor, expected completion time, and execution cost before making any commitment.");
      break;
    case "human_physical":
      out.push("Confirm location, travel/logistics, a suitable physical executor, and total execution cost before making any commitment.");
      break;
    case "hybrid":
      out.push("Define which parts are handled by AI versus a human and verify the human execution cost before making any commitment.");
      break;
    case "manual":
      out.push("Keep execution operator-controlled until requirements and delivery responsibility are clear.");
      break;
    case "unknown":
      out.push("Determine the actual execution route before considering pursuit.");
      break;
  }
  if (evaluation.estimatedEffortMinutes !== null) {
    out.push(`Current estimated effort: ${String(evaluation.estimatedEffortMinutes)} minute(s); re-check before commitment.`);
  }
  return uniqueNonEmpty(out);
}

function requiredChecks(entry: RankedOpportunity): readonly string[] {
  const evaluation = entry.evaluationRecord.evaluation;
  const checks = [
    ...evaluation.blockers,
    ...evaluation.nextChecks,
    ...entry.triage.cautionFlags.map((flag) => `Review caution signal: ${flag}`),
  ];
  if (evaluation.economics.payout === null) {
    checks.push("Verify compensation and payment terms before deciding whether to pursue.");
  }
  if (evaluation.economics.executionCost === null) {
    checks.push("Estimate execution cost before deciding whether to pursue.");
  }
  if (evaluation.economics.payout !== null && evaluation.economics.margin === null) {
    checks.push("Estimate expected margin before deciding whether to pursue.");
  }
  if (entry.executionRoute === "unknown") {
    checks.push("Determine the execution route before deciding whether to pursue.");
  }
  if (entry.opportunity.url === undefined) {
    checks.push("Locate and verify the current source listing before any pursuit decision.");
  }
  return uniqueNonEmpty(checks);
}

function readiness(
  action: OperatorPacketAction,
  checks: readonly string[],
): { readonly state: OperatorReadinessState; readonly nextStep: OperatorNextStep } {
  if (checks.length > 0) {
    return Object.freeze({ state: "needs_checks" as const, nextStep: "resolve_checks" as const });
  }
  if (action === "manual_review") {
    return Object.freeze({ state: "needs_operator_review" as const, nextStep: "operator_review" as const });
  }
  return Object.freeze({
    state: "ready_for_operator_decision" as const,
    nextStep: "operator_decision" as const,
  });
}

function assertPreparableAction(action: RankedOpportunity["operatorAction"]): asserts action is OperatorPacketAction {
  if (!(OPERATOR_PACKET_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`operator packet does not support action ${JSON.stringify(action)}`);
  }
}

/**
 * Convert one already-ranked opportunity into an offline operator preparation packet.
 *
 * This function performs no network/model call and no state mutation. It is not an
 * authorization to contact, claim, submit, hire, or transact; those remain behind a
 * later explicit approval/policy boundary.
 */
export function prepareOpportunityOperatorPacket(
  entry: RankedOpportunity,
): OpportunityOperatorPreparationPacket {
  assertPreparableAction(entry.operatorAction);
  if (entry.evaluationFreshness !== "current") {
    throw new Error("operator packet requires a current evaluation");
  }
  const evaluation = entry.evaluationRecord.evaluation;
  const checks = requiredChecks(entry);
  const ready = readiness(entry.operatorAction, checks);
  const packetId = `opprep_${canonicalHash({
    opportunityId: entry.opportunity.id,
    currentRequestId: entry.currentRequestId,
    evaluatorId: entry.evaluationRecord.evaluatorId,
    evaluatedAt: entry.evaluationRecord.evaluatedAt,
    evaluationHash: canonicalHash(evaluation),
    operatorAction: entry.operatorAction,
    score: entry.score,
    readiness: ready.state,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    packetId,
    opportunity: Object.freeze({
      id: entry.opportunity.id,
      title: entry.opportunity.title,
      ...(entry.opportunity.community === undefined ? {} : { community: entry.opportunity.community }),
      ...(entry.opportunity.url === undefined ? {} : { url: entry.opportunity.url }),
      ...(entry.opportunity.postedAt === undefined ? {} : { postedAt: entry.opportunity.postedAt }),
      observedAt: entry.opportunity.observedAt,
    }),
    triage: Object.freeze({
      decision: entry.triage.decision,
      score: entry.triage.score,
      reasons: entry.triage.reasons,
      cautionFlags: entry.triage.cautionFlags,
      ...(entry.triage.signals.budget === undefined ? {} : { budget: entry.triage.signals.budget }),
    }),
    ranking: Object.freeze({
      score: entry.score,
      priorityBand: entry.priorityBand,
      operatorAction: entry.operatorAction,
      executionRoute: entry.executionRoute,
      currentRequestId: entry.currentRequestId,
      evaluationFreshness: entry.evaluationFreshness,
      evaluatorId: entry.evaluationRecord.evaluatorId,
      evaluatedAt: entry.evaluationRecord.evaluatedAt,
      routingReasons: entry.routingReasons,
      scoreComponents: entry.components,
    }),
    assessment: Object.freeze({
      recommendation: evaluation.recommendation,
      risk: evaluation.risk,
      confidence: evaluation.confidence,
      estimatedEffortMinutes: evaluation.estimatedEffortMinutes,
      economics: evaluation.economics,
      capabilities: evaluation.capabilities,
      reasons: evaluation.reasons,
      blockers: evaluation.blockers,
      nextChecks: evaluation.nextChecks,
    }),
    readiness: ready.state,
    nextSafeStep: ready.nextStep,
    requiredChecks: checks,
    deliveryConsiderations: deliveryConsiderations(entry),
    boundary: Object.freeze({
      externalActionsAllowed: false as const,
      requiresExplicitApprovalBefore: EXTERNAL_ACTIONS_REQUIRING_APPROVAL,
    }),
  });
}

export function prepareOpportunityOperatorPackets(
  entries: readonly RankedOpportunity[],
  limit = 25,
): readonly OpportunityOperatorPreparationPacket[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(1_000, Math.trunc(limit))) : 25;
  if (boundedLimit === 0) return Object.freeze([]);
  const out: OpportunityOperatorPreparationPacket[] = [];
  for (const entry of entries) {
    if (!(OPERATOR_PACKET_ACTIONS as readonly string[]).includes(entry.operatorAction)) continue;
    if (entry.evaluationFreshness !== "current") continue;
    out.push(prepareOpportunityOperatorPacket(entry));
    if (out.length >= boundedLimit) break;
  }
  return Object.freeze(out);
}
