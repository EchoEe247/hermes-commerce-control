import type { OpportunityCandidate } from "./models.js";

export interface DedupeResult {
  readonly fresh: readonly OpportunityCandidate[];
  readonly duplicates: readonly OpportunityCandidate[];
}

/**
 * Stable first-wins deduplication across one ingestion batch and an optional set
 * of already-persisted IDs. Canonical opportunity IDs prefer public URLs, so a
 * Reddit listing observed through RSS and a future webhook/API path can collapse
 * without either adapter knowing about the other.
 */
export function dedupeOpportunities(
  candidates: readonly OpportunityCandidate[],
  seenIds: Iterable<string> = [],
): DedupeResult {
  const seen = new Set(seenIds);
  const fresh: OpportunityCandidate[] = [];
  const duplicates: OpportunityCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      duplicates.push(candidate);
      continue;
    }
    seen.add(candidate.id);
    fresh.push(candidate);
  }

  return Object.freeze({
    fresh: Object.freeze(fresh),
    duplicates: Object.freeze(duplicates),
  });
}
