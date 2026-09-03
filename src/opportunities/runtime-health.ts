import type { OpportunitySourceStatus } from "./models.js";

export interface OpportunitySourceHealthSummary {
  /** At least one configured source completed successfully. */
  readonly ok: boolean;
  /** True when any configured source is degraded, unreachable, or disabled. */
  readonly degraded: boolean;
  readonly healthySources: readonly string[];
  readonly failedSources: readonly string[];
}

/**
 * Summarize source health separately from result count.
 *
 * An empty but reachable feed is healthy. Conversely, zero results from an
 * unreachable feed must not look like a successful "nothing new" pass.
 */
export function summarizeOpportunitySourceHealth(
  sources: Readonly<Record<string, OpportunitySourceStatus>>,
): OpportunitySourceHealthSummary {
  const healthySources: string[] = [];
  const failedSources: string[] = [];
  for (const [id, status] of Object.entries(sources)) {
    if (status.status === "ok") healthySources.push(id);
    else failedSources.push(id);
  }
  healthySources.sort();
  failedSources.sort();
  return Object.freeze({
    ok: healthySources.length > 0,
    degraded: failedSources.length > 0,
    healthySources: Object.freeze(healthySources),
    failedSources: Object.freeze(failedSources),
  });
}
