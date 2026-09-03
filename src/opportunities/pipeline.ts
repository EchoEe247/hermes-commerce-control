import type { OpportunityQuery, OpportunityAggregateResult } from "./models.js";
import type { OpportunityStore } from "./store.js";
import { OpportunityIngestor } from "./ingest.js";

export interface OpportunityPipelineResult extends OpportunityAggregateResult {
  readonly persisted: number;
}

/**
 * Runs one read-only discovery pass against the persisted dedupe set, then saves
 * only newly observed opportunities. No source adapter can perform an external
 * write through this path.
 */
export async function discoverAndPersist(
  ingestor: OpportunityIngestor,
  store: OpportunityStore,
  query: OpportunityQuery = {},
): Promise<OpportunityPipelineResult> {
  const seen = await store.seenIds();
  const result = await ingestor.discover(query, seen);
  const persisted = await store.saveMany(result.results);
  return Object.freeze({ ...result, persisted });
}
