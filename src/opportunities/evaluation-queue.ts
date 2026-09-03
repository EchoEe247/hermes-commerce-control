import { canonicalHash } from "../core/ids.js";
import {
  buildOpportunityEvaluationPacket,
  buildOpportunityEvaluationPrompt,
  OPPORTUNITY_EVALUATION_POLICY_VERSION,
  type OpportunityEvaluationPacket,
} from "./evaluation.js";
import type { OpportunityStore } from "./store.js";
import type { OpportunityTriageDecision, OpportunityTriageProfile } from "./triage.js";
import { reviewStoredOpportunities } from "./review.js";

export interface PreparedOpportunityEvaluation {
  /** Stable request identity derived from evaluation policy + bounded packet, not wall-clock time. */
  readonly requestId: string;
  readonly policyVersion: number;
  readonly opportunityId: string;
  readonly triageDecision: OpportunityTriageDecision;
  readonly triageScore: number;
  readonly packet: OpportunityEvaluationPacket;
  readonly prompt: string;
}

export interface OpportunityEvaluationQueueOptions {
  readonly decisions?: readonly OpportunityTriageDecision[] | undefined;
  readonly minimumScore?: number | undefined;
  readonly limit?: number | undefined;
  readonly scanLimit?: number | undefined;
}

const DEFAULT_QUEUE_DECISIONS = Object.freeze(["candidate", "review"] as const);

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

export function buildPreparedOpportunityEvaluation(
  packet: OpportunityEvaluationPacket,
): PreparedOpportunityEvaluation {
  const requestId = `evalreq_${canonicalHash({
    policyVersion: OPPORTUNITY_EVALUATION_POLICY_VERSION,
    packet,
  }).slice(0, 32)}`;
  return Object.freeze({
    requestId,
    policyVersion: OPPORTUNITY_EVALUATION_POLICY_VERSION,
    opportunityId: packet.opportunity.id,
    triageDecision: packet.triage.decision,
    triageScore: packet.triage.score,
    packet,
    prompt: buildOpportunityEvaluationPrompt(packet),
  });
}

/**
 * Prepare bounded, provider-neutral model requests from durable opportunity state.
 *
 * This stage never calls a model. It is intentionally safe to run before a local
 * provider/coordinator is configured. Stable request IDs include the evaluation
 * policy version so semantic prompt changes invalidate older persisted results
 * rather than silently treating them as current.
 */
export async function prepareOpportunityEvaluationQueue(
  store: OpportunityStore,
  profile: OpportunityTriageProfile = {},
  options: OpportunityEvaluationQueueOptions = {},
): Promise<readonly PreparedOpportunityEvaluation[]> {
  const decisions =
    options.decisions === undefined || options.decisions.length === 0
      ? DEFAULT_QUEUE_DECISIONS
      : options.decisions;
  const scanLimit = boundedInteger(options.scanLimit, 1_000, 1, 10_000);
  const outputLimit = boundedInteger(options.limit, 50, 0, scanLimit);
  if (outputLimit === 0) return Object.freeze([]);

  const reviewed = await reviewStoredOpportunities(store, profile, {
    decisions,
    limit: scanLimit,
    scanLimit,
  });
  const minimumScore = boundedScore(options.minimumScore);
  const out: PreparedOpportunityEvaluation[] = [];
  for (const entry of reviewed) {
    if (entry.triage.score < minimumScore) continue;
    const packet = buildOpportunityEvaluationPacket(entry.opportunity, entry.triage);
    out.push(buildPreparedOpportunityEvaluation(packet));
    if (out.length >= outputLimit) break;
  }
  return Object.freeze(out);
}
