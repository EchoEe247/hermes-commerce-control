/**
 * Adapter registry and aggregate executor.
 *
 * Isolation guarantees:
 *
 *  - One failing platform never fails the aggregate. Each adapter runs in its
 *    own try/catch and contributes a typed per-source status.
 *  - "Healthy with zero results" is success with count 0, not a failure. This
 *    matters because BountyBook legitimately has no open work much of the time.
 *  - A capability the adapter did not declare is never invoked, even if the
 *    method exists on the object.
 *  - Every adapter is bounded by the adapter budget through an AbortSignal, so a
 *    hanging upstream cannot stall the process.
 *  - Concurrency is capped (default 3) to suit a phone.
 *  - Every returned candidate is re-validated against the canonical schema. An
 *    adapter that emits `canPurchase: true` has its results dropped and its
 *    source marked degraded rather than poisoning the result set.
 */
import type { CommerceConfig } from "../config.js";
import { asCommerceError } from "../core/errors.js";
import type {
  AggregateResult,
  PlatformId,
  ProbeResult,
  ServiceCandidate,
  SourceStatus,
  WorkCandidate,
} from "../core/models.js";
import { parseServiceCandidate, parseWorkCandidate } from "../core/schemas.js";
import { EvidenceCollector } from "../evidence/capture.js";
import { createSafeFetch } from "../network/safe-fetch.js";
import type {
  AdapterContext,
  CommerceAdapter,
  ServiceQuery,
  WorkQuery,
} from "./interface.js";

export interface RegistryOptions {
  readonly clock?: (() => string) | undefined;
  readonly allowLocalBaseUrls?: readonly string[] | undefined;
}

interface SourceOutcome<T> {
  readonly platform: PlatformId;
  readonly status: SourceStatus;
  readonly results: readonly T[];
}

export class AdapterRegistry {
  private readonly adapters: readonly CommerceAdapter[];

  public constructor(
    private readonly config: CommerceConfig,
    adapters: readonly CommerceAdapter[],
    private readonly options: RegistryOptions = {},
  ) {
    this.adapters = adapters;
  }

  public list(): readonly CommerceAdapter[] {
    return this.adapters;
  }

  /** Adapters that are enabled in config. */
  public enabled(): readonly CommerceAdapter[] {
    return this.adapters.filter((a) => this.config.adapters[a.id]?.enabled === true);
  }

  public contextFor(platform: PlatformId, signal: AbortSignal): AdapterContext {
    const clock = this.options.clock ?? ((): string => new Date().toISOString());
    const fetchOptions =
      this.options.allowLocalBaseUrls === undefined
        ? {}
        : { allowLocalBaseUrls: this.options.allowLocalBaseUrls };
    return Object.freeze({
      fetch: createSafeFetch(this.config, fetchOptions),
      evidence: new EvidenceCollector(platform, clock),
      clock,
      signal,
      config: this.config,
    });
  }

  public async discoverServices(query: ServiceQuery): Promise<AggregateResult<ServiceCandidate>> {
    return this.runAggregate<ServiceCandidate>(
      "discoverServices",
      (adapter) => adapter.capabilities().discoverServices && adapter.discoverServices !== undefined,
      async (adapter, ctx) => {
        const raw = await adapter.discoverServices!(query, ctx);
        return raw.map((candidate) => parseServiceCandidate(candidate));
      },
    );
  }

  public async discoverWork(query: WorkQuery): Promise<AggregateResult<WorkCandidate>> {
    return this.runAggregate<WorkCandidate>(
      "discoverWork",
      (adapter) => adapter.capabilities().discoverWork && adapter.discoverWork !== undefined,
      async (adapter, ctx) => {
        const raw = await adapter.discoverWork!(query, ctx);
        return raw.map((candidate) => parseWorkCandidate(candidate));
      },
    );
  }

  /** Probes every adapter's health, isolating failures. */
  public async probeAll(): Promise<ProbeResult[]> {
    const clock = this.options.clock ?? ((): string => new Date().toISOString());
    const tasks = this.adapters.map((adapter) => async (): Promise<ProbeResult> => {
      if (this.config.adapters[adapter.id]?.enabled !== true) {
        return {
          platform: adapter.id,
          status: "disabled",
          checkedAt: clock(),
          detail: "adapter disabled by configuration",
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.network.adapterBudgetMs);
      const started = Date.now();
      try {
        const ctx = this.contextFor(adapter.id, controller.signal);
        const probe = await adapter.health(ctx);
        return { ...probe, latencyMs: probe.latencyMs ?? Date.now() - started };
      } catch (error) {
        const typed = asCommerceError(error);
        return {
          platform: adapter.id,
          status: "unreachable",
          checkedAt: clock(),
          latencyMs: Date.now() - started,
          detail: typed.message,
          errorCode: typed.code,
        };
      } finally {
        clearTimeout(timer);
      }
    });
    return this.runBounded(tasks);
  }

  private async runAggregate<T>(
    operation: string,
    supports: (adapter: CommerceAdapter) => boolean,
    invoke: (adapter: CommerceAdapter, ctx: AdapterContext) => Promise<T[]>,
  ): Promise<AggregateResult<T>> {
    const tasks = this.adapters.map((adapter) => async (): Promise<SourceOutcome<T>> => {
      const started = Date.now();

      if (this.config.adapters[adapter.id]?.enabled !== true) {
        return {
          platform: adapter.id,
          status: {
            status: "disabled",
            count: 0,
            durationMs: 0,
            error: "ADAPTER_DISABLED",
          },
          results: [],
        };
      }

      // Capability gate: an undeclared operation is never invoked.
      if (!supports(adapter)) {
        return {
          platform: adapter.id,
          status: {
            status: "disabled",
            count: 0,
            durationMs: 0,
            error: "UNSUPPORTED_OPERATION",
          },
          results: [],
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.network.adapterBudgetMs);
      try {
        const ctx = this.contextFor(adapter.id, controller.signal);
        const results = await invoke(adapter, ctx);
        return {
          platform: adapter.id,
          status: { status: "ok", count: results.length, durationMs: Date.now() - started },
          results,
        };
      } catch (error) {
        const typed = asCommerceError(error);
        // A schema violation means the adapter produced something invalid: the
        // source is degraded, but the rest of the aggregate is unaffected.
        const status =
          typed.code === "SCHEMA_VIOLATION" || typed.code === "UPSTREAM_MALFORMED"
            ? "degraded"
            : typed.code === "UPSTREAM_TIMEOUT" ||
                typed.code === "UPSTREAM_UNAVAILABLE" ||
                typed.code === "SSRF_BLOCKED"
              ? "unreachable"
              : "degraded";
        return {
          platform: adapter.id,
          status: {
            status,
            count: 0,
            durationMs: Date.now() - started,
            error: typed.code,
          },
          results: [],
        };
      } finally {
        clearTimeout(timer);
      }
    });

    const outcomes = await this.runBounded(tasks);
    const sources: Record<string, SourceStatus> = {};
    const results: T[] = [];
    for (const outcome of outcomes) {
      sources[outcome.platform] = outcome.status;
      results.push(...outcome.results);
    }
    void operation;
    return Object.freeze({ sources: Object.freeze(sources), results: Object.freeze(results) });
  }

  /** Runs tasks with a fixed worker pool so concurrency never exceeds the cap. */
  private async runBounded<R>(tasks: ReadonlyArray<() => Promise<R>>): Promise<R[]> {
    const limit = Math.max(1, this.config.concurrency);
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

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
  }
}
