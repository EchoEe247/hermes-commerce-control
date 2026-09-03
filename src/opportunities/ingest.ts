/**
 * Provider-independent opportunity ingestion registry.
 *
 * Source failures are isolated. A dead RSS feed or future WebMCP adapter cannot
 * fail the whole discovery pass. Results are deduplicated only after all source
 * adapters return, so cross-source canonical IDs collapse cleanly.
 */
import type { SafeFetch } from "../network/safe-fetch.js";
import { CommerceError } from "../core/errors.js";
import { dedupeOpportunities } from "./dedupe.js";
import type { OpportunitySourceAdapter } from "./adapters/interface.js";
import {
  parseOpportunityCandidate,
  type OpportunityAggregateResult,
  type OpportunityCandidate,
  type OpportunityQuery,
  type OpportunitySourceStatus,
} from "./models.js";

export interface OpportunityIngestorOptions {
  readonly clock?: (() => string) | undefined;
  readonly adapterBudgetMs?: number | undefined;
  readonly concurrency?: number | undefined;
}

interface AdapterOutcome {
  readonly id: string;
  readonly status: OpportunitySourceStatus;
  readonly results: readonly OpportunityCandidate[];
}

export class OpportunityIngestor {
  private readonly clock: () => string;
  private readonly adapterBudgetMs: number;
  private readonly concurrency: number;

  public constructor(
    private readonly fetch: Pick<SafeFetch, "text">,
    private readonly adapters: readonly OpportunitySourceAdapter[],
    options: OpportunityIngestorOptions = {},
  ) {
    this.clock = options.clock ?? ((): string => new Date().toISOString());
    this.adapterBudgetMs = Math.max(500, options.adapterBudgetMs ?? 30_000);
    this.concurrency = Math.max(1, Math.min(8, options.concurrency ?? 3));
  }

  public async discover(
    query: OpportunityQuery = {},
    seenIds: Iterable<string> = [],
  ): Promise<OpportunityAggregateResult> {
    const tasks = this.adapters.map((adapter) => async (): Promise<AdapterOutcome> => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.adapterBudgetMs);
      try {
        const raw = await adapter.discover(query, {
          fetch: this.fetch,
          clock: this.clock,
          signal: controller.signal,
        });
        const results = raw.map((candidate) => {
          const parsed = parseOpportunityCandidate(candidate);
          if (parsed.source !== adapter.id) {
            throw new CommerceError(
              "SCHEMA_VIOLATION",
              `opportunity adapter ${adapter.id} emitted candidate source ${parsed.source}`,
            );
          }
          return parsed;
        });
        return {
          id: adapter.id,
          status: {
            status: "ok",
            count: results.length,
            durationMs: Date.now() - started,
          },
          results,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unreachable = /abort|timeout|network|fetch|unavailable|dns/i.test(message);
        return {
          id: adapter.id,
          status: {
            status: unreachable ? "unreachable" : "degraded",
            count: 0,
            durationMs: Date.now() - started,
            error: message,
          },
          results: [],
        };
      } finally {
        clearTimeout(timer);
      }
    });

    const outcomes = await this.runBounded(tasks);
    const sources: Record<string, OpportunitySourceStatus> = {};
    const combined: OpportunityCandidate[] = [];
    for (const outcome of outcomes) {
      sources[outcome.id] = outcome.status;
      combined.push(...outcome.results);
    }

    const deduped = dedupeOpportunities(combined, seenIds);
    return Object.freeze({
      sources: Object.freeze(sources),
      results: deduped.fresh,
      duplicatesDropped: deduped.duplicates.length,
    });
  }

  private async runBounded<R>(tasks: ReadonlyArray<() => Promise<R>>): Promise<R[]> {
    const results = new Array<R>(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= tasks.length) return;
        const task = tasks[index];
        if (task === undefined) return;
        results[index] = await task();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker()));
    return results;
  }
}
