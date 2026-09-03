import type { OpportunityCandidate } from "./models.js";
import type { OpportunityStore } from "./store.js";
import {
  triageOpportunity,
  type OpportunityTriageDecision,
  type OpportunityTriageProfile,
  type OpportunityTriageResult,
} from "./triage.js";

export interface OpportunityReviewEntry {
  readonly opportunity: OpportunityCandidate;
  readonly triage: OpportunityTriageResult;
}

export interface OpportunityReviewQuery {
  readonly decisions?: readonly OpportunityTriageDecision[] | undefined;
  readonly limit?: number | undefined;
  readonly scanLimit?: number | undefined;
}

/**
 * Re-triage persisted discovery signals without touching the network.
 *
 * The raw opportunity store is deliberately the durable source of truth for the
 * early discovery layer. This view lets an operator change profiles/thresholds
 * later and recover useful listings even if the original watcher output was
 * missed. It never mutates the stored opportunities.
 */
export async function reviewStoredOpportunities(
  store: OpportunityStore,
  profile: OpportunityTriageProfile = {},
  query: OpportunityReviewQuery = {},
): Promise<readonly OpportunityReviewEntry[]> {
  const decisions =
    query.decisions === undefined || query.decisions.length === 0
      ? undefined
      : new Set(query.decisions);
  const scanLimit = Math.max(1, Math.min(10_000, Math.trunc(query.scanLimit ?? 1_000)));
  const outputLimit = Math.max(0, Math.min(scanLimit, Math.trunc(query.limit ?? 100)));
  if (outputLimit === 0) return Object.freeze([]);

  const candidates = await store.list(scanLimit);
  const out: OpportunityReviewEntry[] = [];
  for (const opportunity of candidates) {
    const triage = triageOpportunity(opportunity, profile);
    if (decisions !== undefined && !decisions.has(triage.decision)) continue;
    out.push(Object.freeze({ opportunity, triage }));
    if (out.length >= outputLimit) break;
  }
  return Object.freeze(out);
}
