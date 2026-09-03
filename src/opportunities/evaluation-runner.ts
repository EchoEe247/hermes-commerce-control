import { parseOpportunityEvaluation, type OpportunityEvaluator } from "./evaluation.js";
import type { PreparedOpportunityEvaluation } from "./evaluation-queue.js";
import {
  evaluationResultKey,
  type OpportunityEvaluationClaim,
  type OpportunityEvaluationResultStore,
  type PersistedOpportunityEvaluation,
} from "./evaluation-results.js";

export interface OpportunityEvaluationRunnerOptions {
  readonly continueOnError?: boolean | undefined;
  readonly clock?: (() => string) | undefined;
}

export interface OpportunityEvaluationRunCompleted {
  readonly status: "completed";
  readonly requestId: string;
  readonly opportunityId: string;
  readonly evaluatorId: string;
  readonly record: PersistedOpportunityEvaluation;
}

export interface OpportunityEvaluationRunSkipped {
  readonly status: "skipped";
  readonly requestId: string;
  readonly opportunityId: string;
  readonly evaluatorId: string;
  readonly reason: "already_evaluated" | "claimed_elsewhere";
}

export interface OpportunityEvaluationRunFailed {
  readonly status: "failed";
  readonly requestId: string;
  readonly opportunityId: string;
  readonly evaluatorId: string;
  readonly error: string;
}

export type OpportunityEvaluationRunnerResult =
  | OpportunityEvaluationRunCompleted
  | OpportunityEvaluationRunSkipped
  | OpportunityEvaluationRunFailed;

export async function runPreparedOpportunityEvaluations(
  queue: readonly PreparedOpportunityEvaluation[],
  evaluator: OpportunityEvaluator,
  store: OpportunityEvaluationResultStore,
  options: OpportunityEvaluationRunnerOptions = {},
): Promise<readonly OpportunityEvaluationRunnerResult[]> {
  const seen = new Set(await store.seenKeys());
  const clock = options.clock ?? (() => new Date().toISOString());
  const continueOnError = options.continueOnError ?? true;
  const results: OpportunityEvaluationRunnerResult[] = [];

  for (const item of queue) {
    const key = evaluationResultKey(item.requestId, evaluator.id);
    if (seen.has(key)) {
      results.push(
        Object.freeze({
          status: "skipped" as const,
          requestId: item.requestId,
          opportunityId: item.opportunityId,
          evaluatorId: evaluator.id,
          reason: "already_evaluated" as const,
        }),
      );
      continue;
    }

    let claim: OpportunityEvaluationClaim | undefined;
    if (store.claim !== undefined) {
      const attempt = await store.claim(item.requestId, evaluator.id);
      if (attempt.status !== "acquired") {
        if (attempt.status === "already_evaluated") seen.add(key);
        results.push(
          Object.freeze({
            status: "skipped" as const,
            requestId: item.requestId,
            opportunityId: item.opportunityId,
            evaluatorId: evaluator.id,
            reason: attempt.status,
          }),
        );
        continue;
      }
      claim = attempt.claim;
    }

    try {
      const raw = await evaluator.evaluate(item.packet);
      const evaluation = parseOpportunityEvaluation(raw);
      const record: PersistedOpportunityEvaluation = Object.freeze({
        requestId: item.requestId,
        opportunityId: item.opportunityId,
        evaluatorId: evaluator.id,
        evaluatedAt: clock(),
        evaluation,
      });
      await store.append(record);
      seen.add(key);
      results.push(
        Object.freeze({
          status: "completed" as const,
          requestId: item.requestId,
          opportunityId: item.opportunityId,
          evaluatorId: evaluator.id,
          record,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        Object.freeze({
          status: "failed" as const,
          requestId: item.requestId,
          opportunityId: item.opportunityId,
          evaluatorId: evaluator.id,
          error: message,
        }),
      );
      if (!continueOnError) break;
    } finally {
      if (claim !== undefined && store.releaseClaim !== undefined) {
        await store.releaseClaim(claim);
      }
    }
  }

  return Object.freeze(results);
}
