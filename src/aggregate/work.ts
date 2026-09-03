/**
 * Work aggregation.
 *
 * Work identity is scoped per source, because bounty "42" on Agent Bounties and
 * bounty "42" on BountyBook are different pieces of work. There is therefore no
 * cross-source merge here, only deterministic ordering and filtering.
 *
 * Closed and unfunded work is excluded rather than ranked low: a bounty nobody
 * can be paid for is not an opportunity, and leaving it in the list to be sorted
 * downwards would waste a reviewer's attention.
 */
import type { WorkCandidate } from "../core/models.js";

/** Funding states that mean nobody can still earn this. */
const UNEARNABLE_FUNDING = new Set(["unfunded", "advertised", "settled", "refunded", "unknown"]);

export interface WorkFilterOptions {
  /** Include work that cannot currently be earned. Defaults to false. */
  readonly includeUnearnable?: boolean | undefined;
}

/**
 * Deduplicates by canonical ID and orders deterministically.
 *
 * Duplicates can occur when the same snapshot is scanned twice within one
 * aggregate call; the newest observation wins.
 */
export function dedupeWork(candidates: readonly WorkCandidate[]): WorkCandidate[] {
  const byId = new Map<string, WorkCandidate>();
  for (const candidate of candidates) {
    const prior = byId.get(candidate.id);
    if (prior === undefined || candidate.observedAt > prior.observedAt) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Excludes work that is closed or cannot be funded/earned. */
export function filterEarnableWork(
  candidates: readonly WorkCandidate[],
  options: WorkFilterOptions = {},
): WorkCandidate[] {
  if (options.includeUnearnable === true) return [...candidates];
  return candidates.filter((w) => {
    if (w.status === "closed") return false;
    if (w.status === "unknown") return false;
    if (UNEARNABLE_FUNDING.has(w.funding.state)) return false;
    return true;
  });
}

/** Convenience: dedupe then filter, in that order. */
export function aggregateWork(
  candidates: readonly WorkCandidate[],
  options: WorkFilterOptions = {},
): WorkCandidate[] {
  return filterEarnableWork(dedupeWork(candidates), options);
}
