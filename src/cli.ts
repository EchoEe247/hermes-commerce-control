#!/usr/bin/env node
/**
 * The Hermes commerce control-plane CLI.
 *
 * Stream contract, which the MCP server and any script may rely on:
 *
 *  - With `--json`, stdout carries EXACTLY ONE compact JSON document and nothing
 *    else. Every warning, note and verbose line goes to stderr. A caller can
 *    therefore pipe stdout straight into a parser without filtering.
 *  - Without `--json`, stdout carries human text only.
 *
 * Exit codes:
 *
 *   0  the operation succeeded
 *   1  the operation failed (bad config, unreachable target, unwritable state)
 *   2  the invocation was wrong (unknown command, missing argument, bad option)
 *
 * The subtle one is exit 0 for a blocked preparation. `prepare purchase` returns
 * 0 because the *preparation* is what was asked for and it succeeded; the policy
 * block travels inside the JSON as a decision record. Treating a correct refusal
 * as a process failure would teach a caller to retry it.
 *
 * There is no command here that can pay, claim, submit, settle or publish. The
 * command table is a closed list, and every action path terminates in an intent.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { APP_MODE, APP_NAME, APP_VERSION } from "./app.js";
import { loadConfig, type CommerceConfig, type Env } from "./config.js";
import { capabilities } from "./core/capabilities.js";
import { asCommerceError, CommerceError } from "./core/errors.js";
import { operationId } from "./core/ids.js";
import { PLATFORM_IDS, type PlatformId, type ProbeResult } from "./core/models.js";
import { AdapterRegistry, type RegistryOptions } from "./adapters/registry.js";
import type {
  AdapterContext,
  CommerceAdapter,
  ServiceQuery,
  WorkQuery,
} from "./adapters/interface.js";
import { CdpBazaarAdapter } from "./adapters/cdp-bazaar/index.js";
import { Agent402Adapter } from "./adapters/agent402/index.js";
import { PipRailAdapter } from "./adapters/piprail/index.js";
import { AgentBountiesAdapter } from "./adapters/agent-bounties/index.js";
import { BountyBookAdapter } from "./adapters/bountybook/index.js";
import { The402Adapter } from "./adapters/the402/index.js";
import { PayShAdapter } from "./adapters/paysh/index.js";
import { dedupeServices } from "./aggregate/services.js";
import { aggregateWork } from "./aggregate/work.js";
import { rankServices, type ServiceRankOptions } from "./ranking/services.js";
import { rankWork, type WorkRankOptions } from "./ranking/work.js";
import { preparePurchase, type PurchaseFacts } from "./actions/purchase.js";
import { prepareClaim, type ClaimFacts } from "./actions/claim.js";
import { preparePublish } from "./actions/publish.js";
import { intentToRecord, type CommerceIntent } from "./actions/intents.js";
import {
  buildProfilerManifest,
  inspectProfiler,
  PRODUCT_NAME,
} from "./products/data-quality-profiler.js";
import { exportRepositoryOutputs } from "./export/repo.js";
import { findWalletSecretEnvNames, runDoctor } from "./doctor.js";
import { CommerceRepository } from "./state/repository.js";
import { closeStateDatabase, openStateDatabase } from "./state/sqlite.js";
import { currentSchemaVersion, runMigrations } from "./state/migrations.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * The closed command surface.
 *
 * Nothing outside this list is dispatchable, so a live-execution verb cannot be
 * reached even by accident.
 */
export const CLI_COMMANDS: readonly string[] = Object.freeze([
  "sources",
  "status",
  "discover services",
  "discover work",
  "inspect",
  "quote",
  "prepare purchase",
  "prepare claim",
  "prepare publish",
  "probe",
  "export",
  "doctor",
]);

/**
 * Publication targets, in deterministic order.
 *
 * Declared as a const tuple so the MCP layer can derive a strict enum schema
 * from the same source of truth instead of restating the list.
 */
export const PUBLISH_TARGETS = Object.freeze(["agent402", "cdp_bazaar", "paysh"] as const) satisfies
  readonly PlatformId[];

export interface CliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export interface CliDeps {
  readonly env?: Env | undefined;
  readonly clock?: (() => string) | undefined;
  /** Injected adapters. Defaults to the seven production adapters. */
  readonly adapters?: readonly CommerceAdapter[] | undefined;
  readonly registryOptions?: RegistryOptions | undefined;
}

const HELP = `${APP_NAME} ${APP_VERSION} — Mode ${APP_MODE} commerce control plane

Usage: commerce <command> [options]

Commands:
  commerce sources                              list platforms, capabilities and health
  commerce status                               local Mode-A status and state counts
  commerce discover services <query>            aggregate and rank paid services
  commerce discover work                        aggregate and rank earnable work
  commerce inspect <id>                         inspect one service or work item
  commerce quote <id>                           quote a service (never executable)
  commerce prepare purchase <id>                build a blocked payment intent
  commerce prepare claim <id>                   build a blocked claim intent
  commerce prepare publish data-quality-profiler
                                                build a blocked publication intent
  commerce probe                                probe every platform's health
  commerce export                               write normalized evidence to the repo
  commerce doctor                               diagnose runtime, state and policy

Target syntax for inspect/quote/prepare:
  <platform>:<externalId>   e.g. cdp_bazaar:0xabc
  svc_<hash> / wrk_<hash>   a canonical ID already present in local state

Options:
  --json                    emit one JSON document on stdout, diagnostics on stderr
  --verbose                 add diagnostics on stderr
  --limit <n>               maximum results per source
  --network <id>            preferred network, e.g. eip155:84532
  --protocol <id>           preferred protocol, e.g. x402
  --max-usd-price <amount>  hard filter: exclude services priced above this
  --min-reward <amount>     hard filter: exclude work rewarding less than this
  --capability <name>       solver capability for work requirement fit (repeatable)
  --include-unearnable      keep closed or unfunded work in the result
  --target <platform>       restrict prepare publish to one target
  --help, --version

Mode A is fixed: external writes and live value movement are disabled, no wallet
or signing key is read, and every action path stops at a preparation artifact.
`;

// ------------------------------------------------------------------ envelope

interface Envelope {
  readonly ok: boolean;
  readonly command: string;
  readonly mode: typeof APP_MODE;
  readonly version: typeof APP_VERSION;
  readonly generatedAt: string;
  /** Invariants restated on every response so a caller never has to infer them. */
  readonly financialActionExecuted: false;
  readonly externalMutationExecuted: false;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

interface CommandResult {
  readonly data: unknown;
  readonly human: string;
  readonly exitCode?: number | undefined;
}

// -------------------------------------------------------------------- helpers

function asPlatformId(value: string): PlatformId | undefined {
  return (PLATFORM_IDS as readonly string[]).includes(value) ? (value as PlatformId) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CommerceError("INVALID_INPUT", `--${name} must be a positive integer`);
  }
  return parsed;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of [...values].sort()) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/** True when any source ended in a non-ok, non-disabled state. */
function isDegraded(sources: Readonly<Record<string, { status: string }>>): boolean {
  return Object.values(sources).some(
    (source) => source.status === "degraded" || source.status === "unreachable",
  );
}

// ------------------------------------------------------------------- context

interface RunContext {
  readonly config: CommerceConfig;
  readonly env: Env;
  readonly clock: () => string;
  readonly adapters: readonly CommerceAdapter[];
  readonly registry: AdapterRegistry;
  readonly byId: ReadonlyMap<PlatformId, CommerceAdapter>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly positionals: readonly string[];
  /** Unconditional stderr diagnostic. */
  readonly warn: (message: string) => void;
  /** stderr diagnostic emitted only with --verbose. */
  readonly note: (message: string) => void;
  readonly withRepo: <T>(fn: (repo: CommerceRepository) => T) => T;
  readonly runAdapter: <T>(
    platform: PlatformId,
    fn: (context: AdapterContext) => Promise<T>,
  ) => Promise<T>;
}

function defaultAdapters(config: CommerceConfig): CommerceAdapter[] {
  // Adapters whose upstream base is configurable receive it; the others own
  // their endpoint shape (PipRail through its SDK seam, Pay.sh through the
  // pay-skills registry, BountyBook through its API host).
  return [
    new CdpBazaarAdapter(config.adapters.cdp_bazaar.baseUrl),
    new Agent402Adapter(config.adapters.agent402.baseUrl),
    new PipRailAdapter(),
    new AgentBountiesAdapter(config.adapters.agent_bounties.baseUrl),
    new BountyBookAdapter(),
    new The402Adapter(config.adapters.the402.baseUrl),
    new PayShAdapter(),
  ];
}

// ------------------------------------------------------------------ commands

function commandSources(ctx: RunContext): CommandResult {
  const probes = ctx.withRepo((repo) => {
    const map = new Map<PlatformId, ProbeResult | null>();
    for (const platform of PLATFORM_IDS) map.set(platform, repo.listProbes(platform, 1)[0] ?? null);
    return map;
  });

  const sources = PLATFORM_IDS.map((platform) => {
    const adapter = ctx.byId.get(platform);
    const probe = probes.get(platform) ?? null;
    return {
      platform,
      enabled: ctx.config.adapters[platform].enabled,
      registered: adapter !== undefined,
      baseUrl: ctx.config.adapters[platform].baseUrl,
      // A platform with no registered adapter supports nothing; the shape is
      // kept uniform so a machine caller never has to branch on null.
      capabilities: adapter === undefined ? capabilities() : adapter.capabilities(),
      lastProbe:
        probe === null
          ? null
          : { status: probe.status, checkedAt: probe.checkedAt, errorCode: probe.errorCode ?? null },
    };
  });

  const human = [
    `${APP_NAME} ${APP_VERSION} — mode ${APP_MODE}`,
    "",
    ...sources.map((source) => {
      const state = source.enabled ? (source.registered ? "enabled" : "no adapter") : "disabled";
      const health = source.lastProbe === null ? "never probed" : source.lastProbe.status;
      return `  ${source.platform.padEnd(15)} ${state.padEnd(11)} ${health}`;
    }),
  ].join("\n");

  return { data: { count: sources.length, sources }, human };
}

function commandStatus(ctx: RunContext): CommandResult {
  const state = ctx.withRepo((repo) => ({
    services: repo.listServices(10_000).length,
    work: repo.listWork(10_000).length,
    intents: repo.listIntents(10_000).length,
    probes: repo.listProbes(undefined, 10_000).length,
    lastProbes: PLATFORM_IDS.map((platform) => {
      const probe = repo.listProbes(platform, 1)[0];
      return {
        platform,
        status: probe?.status ?? null,
        checkedAt: probe?.checkedAt ?? null,
      };
    }),
  }));

  const walletSecretNames = findWalletSecretEnvNames(ctx.env);

  const data = {
    tool: APP_NAME,
    version: APP_VERSION,
    mode: APP_MODE,
    externalWritesEnabled: false,
    liveValueMovementEnabled: false,
    walletSecretPresent: walletSecretNames.length > 0,
    node: process.versions.node,
    schemaVersion: currentSchemaVersion(),
    paths: {
      stateRoot: ctx.config.stateRoot,
      databasePath: ctx.config.databasePath,
      cacheRoot: ctx.config.cacheRoot,
      logRoot: ctx.config.logRoot,
      repoRoot: ctx.config.repoRoot,
    },
    concurrency: ctx.config.concurrency,
    network: ctx.config.network,
    adapters: PLATFORM_IDS.map((platform) => ({
      platform,
      enabled: ctx.config.adapters[platform].enabled,
      registered: ctx.byId.has(platform),
    })),
    counts: {
      services: state.services,
      work: state.work,
      intents: state.intents,
      probes: state.probes,
    },
    lastProbes: state.lastProbes,
    generatedAt: ctx.clock(),
  };

  const human = [
    `${APP_NAME} ${APP_VERSION}`,
    `mode: ${APP_MODE}  (external writes: off, live value movement: off)`,
    `node: ${process.versions.node}   schema: ${String(currentSchemaVersion())}`,
    `wallet secret present: ${String(data.walletSecretPresent)}`,
    `state: ${ctx.config.stateRoot}`,
    `repo:  ${ctx.config.repoRoot}`,
    `counts: services=${String(state.services)} work=${String(state.work)} ` +
      `intents=${String(state.intents)} probes=${String(state.probes)}`,
  ].join("\n");

  return { data, human };
}

async function commandDiscoverServices(ctx: RunContext): Promise<CommandResult> {
  const now = ctx.clock();
  const q = optionalString(ctx.positionals[2]);
  const limit = parsePositiveInt(optionalString(ctx.values.limit), "limit");
  const network = optionalString(ctx.values.network);
  const protocol = optionalString(ctx.values.protocol);
  const maxUsdPrice = optionalString(ctx.values["max-usd-price"]);

  const query: ServiceQuery = {
    ...(q === undefined ? {} : { q }),
    ...(network === undefined ? {} : { network }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(maxUsdPrice === undefined ? {} : { maxUsdPrice }),
    ...(limit === undefined ? {} : { limit }),
  };

  ctx.note(`discover services: querying ${String(ctx.adapters.length)} adapters`);
  const aggregate = await ctx.registry.discoverServices(query);

  for (const [platform, status] of Object.entries(aggregate.sources)) {
    if (status.status === "degraded" || status.status === "unreachable") {
      ctx.warn(`source ${platform} is ${status.status}${status.error === undefined ? "" : ` (${status.error})`}`);
    }
  }

  const merged = dedupeServices(aggregate.results);
  const rankOptions: ServiceRankOptions = {
    now,
    ...(maxUsdPrice === undefined ? {} : { maxUsdPrice }),
    ...(network === undefined ? {} : { preferredNetwork: network }),
    ...(protocol === undefined ? {} : { preferredProtocol: protocol }),
  };
  const ranked = rankServices(merged, rankOptions);

  ctx.withRepo((repo) => {
    for (const service of merged) repo.saveService(service);
    for (const platform of PLATFORM_IDS) {
      repo.upsertSource(
        platform,
        ctx.config.adapters[platform].enabled,
        ctx.config.adapters[platform].baseUrl,
        aggregate.sources[platform]?.status,
      );
    }
    recordOperation(repo, "discover_services", now, ctx.clock(), aggregate.sources, ranked.length);
  });

  const data = {
    query,
    sources: aggregate.sources,
    degraded: isDegraded(aggregate.sources),
    counts: { raw: aggregate.results.length, canonical: merged.length, ranked: ranked.length },
    results: ranked.map((entry) => ({
      score: entry.score,
      breakdown: entry.breakdown,
      service: entry.service,
    })),
    generatedAt: now,
  };

  const human = [
    `${String(ranked.length)} service(s)${data.degraded ? " (degraded: some sources failed)" : ""}`,
    ...ranked.map(
      (entry, index) =>
        `  ${String(index + 1).padStart(2)}. ${entry.score.toFixed(2).padStart(6)}  ` +
        `${entry.service.id}  ${entry.service.name}  ` +
        `${entry.service.price?.display ?? entry.service.price?.decimal ?? "price unknown"}`,
    ),
  ].join("\n");

  return { data, human };
}

async function commandDiscoverWork(ctx: RunContext): Promise<CommandResult> {
  const now = ctx.clock();
  const q = optionalString(ctx.positionals[2]);
  const limit = parsePositiveInt(optionalString(ctx.values.limit), "limit");
  const network = optionalString(ctx.values.network);
  const minReward = optionalString(ctx.values["min-reward"]);
  const solverCapabilities = stringArray(ctx.values.capability);
  const includeUnearnable = ctx.values["include-unearnable"] === true;

  const query: WorkQuery = {
    ...(q === undefined ? {} : { q }),
    ...(network === undefined ? {} : { network }),
    ...(minReward === undefined ? {} : { minReward }),
    ...(limit === undefined ? {} : { limit }),
  };

  ctx.note(`discover work: querying ${String(ctx.adapters.length)} adapters`);
  const aggregate = await ctx.registry.discoverWork(query);

  for (const [platform, status] of Object.entries(aggregate.sources)) {
    if (status.status === "degraded" || status.status === "unreachable") {
      ctx.warn(`source ${platform} is ${status.status}${status.error === undefined ? "" : ` (${status.error})`}`);
    }
  }

  const filtered = aggregateWork(aggregate.results, { includeUnearnable });
  const rankOptions: WorkRankOptions = {
    now,
    ...(minReward === undefined ? {} : { minReward }),
    ...(solverCapabilities.length === 0 ? {} : { capabilities: solverCapabilities }),
  };
  const ranked = rankWork(filtered, rankOptions);

  ctx.withRepo((repo) => {
    for (const work of filtered) repo.saveWork(work);
    recordOperation(repo, "discover_work", now, ctx.clock(), aggregate.sources, ranked.length);
  });

  const data = {
    query,
    sources: aggregate.sources,
    degraded: isDegraded(aggregate.sources),
    counts: {
      raw: aggregate.results.length,
      earnable: filtered.length,
      ranked: ranked.length,
    },
    results: ranked.map((entry) => ({
      score: entry.score,
      breakdown: entry.breakdown,
      work: entry.work,
    })),
    generatedAt: now,
  };

  const human = [
    `${String(ranked.length)} earnable item(s)${data.degraded ? " (degraded: some sources failed)" : ""}`,
    ...ranked.map(
      (entry, index) =>
        `  ${String(index + 1).padStart(2)}. ${entry.score.toFixed(2).padStart(6)}  ` +
        `${entry.work.id}  ${entry.work.reward.amount} ${entry.work.reward.asset}  ${entry.work.title}`,
    ),
  ].join("\n");

  return { data, human };
}

/** Persists a bounded operation receipt for an aggregate run. */
function recordOperation(
  repo: CommerceRepository,
  type: string,
  startedAt: string,
  endedAt: string,
  sources: Readonly<Record<string, { status: string; error?: string | undefined }>>,
  resultCount: number,
): void {
  const entries = Object.entries(sources);
  const succeeded = entries.filter(([, s]) => s.status === "ok").length;
  const failed = entries.filter(
    ([, s]) => s.status === "degraded" || s.status === "unreachable",
  ).length;
  const errors = entries
    .filter(([, s]) => s.error !== undefined)
    .map(([platform, s]) => `${platform}:${String(s.error)}`)
    .sort();

  repo.saveOperation({
    id: operationId(type, startedAt, 0),
    type,
    startedAt,
    endedAt,
    mode: "A",
    sourcesRequested: entries.length,
    sourcesSucceeded: succeeded,
    sourcesFailed: failed,
    resultCount,
    // Invariant: an aggregate read can never have moved value or mutated state.
    financialActionExecuted: false,
    externalMutationExecuted: false,
    ...(errors.length === 0 ? {} : { errors }),
  });
}

interface ResolvedTarget {
  readonly platform: PlatformId;
  readonly externalId: string;
  readonly canonicalId: string | null;
}

/**
 * Resolves a user-supplied target into a platform and platform-native ID.
 *
 * Accepts `platform:externalId` directly, or a canonical `svc_`/`wrk_` ID that
 * local state can map back to its source observation.
 */
function resolveTarget(ctx: RunContext, raw: string): ResolvedTarget {
  const separator = raw.indexOf(":");
  if (separator > 0) {
    const platform = asPlatformId(raw.slice(0, separator));
    const externalId = raw.slice(separator + 1);
    if (platform !== undefined && externalId !== "") {
      return { platform, externalId, canonicalId: null };
    }
  }

  if (raw.startsWith("svc_")) {
    return ctx.withRepo((repo) => {
      const service = repo.getService(raw);
      if (service === null) {
        throw new CommerceError(
          "NOT_FOUND",
          `no service ${raw} in local state; run discover first or use platform:externalId`,
          { target: raw },
        );
      }
      const observations = [...service.sources].sort((a, b) =>
        a.source === b.source
          ? a.externalId < b.externalId
            ? -1
            : 1
          : a.source < b.source
            ? -1
            : 1,
      );
      const first = observations[0];
      if (first === undefined) {
        throw new CommerceError("NOT_FOUND", `service ${raw} has no source observation`, {
          target: raw,
        });
      }
      return { platform: first.source, externalId: first.externalId, canonicalId: service.id };
    });
  }

  if (raw.startsWith("wrk_")) {
    return ctx.withRepo((repo) => {
      const work = repo.getWork(raw);
      if (work === null) {
        throw new CommerceError(
          "NOT_FOUND",
          `no work ${raw} in local state; run discover first or use platform:externalId`,
          { target: raw },
        );
      }
      return { platform: work.source, externalId: work.externalId, canonicalId: work.id };
    });
  }

  throw new CommerceError(
    "INVALID_INPUT",
    `unrecognized target ${JSON.stringify(raw)}; expected platform:externalId, svc_<hash> or wrk_<hash>`,
    { target: raw },
  );
}

/** Returns the adapter for a platform, refusing a disabled or absent one. */
function adapterFor(ctx: RunContext, platform: PlatformId): CommerceAdapter {
  if (!ctx.config.adapters[platform].enabled) {
    throw new CommerceError("ADAPTER_DISABLED", `adapter ${platform} is disabled by configuration`, {
      platform,
    });
  }
  const adapter = ctx.byId.get(platform);
  if (adapter === undefined) {
    throw new CommerceError("NOT_FOUND", `no adapter registered for ${platform}`, { platform });
  }
  return adapter;
}

function requireTargetArgument(ctx: RunContext, index: number, what: string): string {
  const raw = optionalString(ctx.positionals[index]);
  if (raw === undefined) {
    throw new CommerceError("INVALID_INPUT", `${what} requires a target argument`);
  }
  return raw;
}

async function commandInspect(ctx: RunContext): Promise<CommandResult> {
  const raw = requireTargetArgument(ctx, 1, "inspect");
  const target = resolveTarget(ctx, raw);
  const adapter = adapterFor(ctx, target.platform);
  if (!adapter.capabilities().inspect || adapter.inspect === undefined) {
    throw new CommerceError(
      "UNSUPPORTED_OPERATION",
      `adapter ${target.platform} does not support inspect`,
      { platform: target.platform },
    );
  }

  const inspect = adapter.inspect.bind(adapter);
  const result = await ctx.runAdapter(target.platform, (context) =>
    inspect(target.externalId, context),
  );

  ctx.withRepo((repo) => {
    if (result.service !== undefined) repo.saveService(result.service);
    if (result.work !== undefined) repo.saveWork(result.work);
    for (const record of result.evidence) repo.saveEvidence(record);
  });

  const data = {
    platform: result.platform,
    externalId: result.externalId,
    canonicalId: target.canonicalId ?? result.service?.id ?? result.work?.id ?? null,
    inspectedAt: result.inspectedAt,
    service: result.service,
    work: result.work,
    evidence: result.evidence,
  };

  const kind = result.service !== undefined ? "service" : result.work !== undefined ? "work" : "unknown";
  const human = [
    `${result.platform}:${result.externalId} (${kind})`,
    `inspected at ${result.inspectedAt}`,
    `evidence records: ${String(result.evidence.length)}`,
    result.service === undefined
      ? ""
      : `service: ${result.service.name} ${result.service.method} ${result.service.resourceUrl}`,
    result.work === undefined
      ? ""
      : `work: ${result.work.title} reward ${result.work.reward.amount} ${result.work.reward.asset}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { data, human };
}

async function commandQuote(ctx: RunContext): Promise<CommandResult> {
  const raw = requireTargetArgument(ctx, 1, "quote");
  const target = resolveTarget(ctx, raw);
  const adapter = adapterFor(ctx, target.platform);
  if (!adapter.capabilities().quote || adapter.quote === undefined) {
    throw new CommerceError(
      "UNSUPPORTED_OPERATION",
      `adapter ${target.platform} does not support quote`,
      { platform: target.platform },
    );
  }

  const quoteFn = adapter.quote.bind(adapter);
  const quote = await ctx.runAdapter(target.platform, (context) =>
    quoteFn(target.externalId, context),
  );

  ctx.withRepo((repo) => {
    repo.saveQuote(quote);
    for (const record of quote.evidence) repo.saveEvidence(record);
  });

  const human = [
    `quote for ${quote.platform}:${target.externalId}`,
    `${quote.method} ${quote.resourceUrl}`,
    `protocol ${quote.protocol}${quote.network === undefined ? "" : ` on ${quote.network}`}`,
    `price ${quote.price?.display ?? quote.price?.decimal ?? "unknown"}`,
    "executable: false (Mode A never produces an executable quote)",
  ].join("\n");

  return { data: { platform: quote.platform, externalId: target.externalId, quote }, human };
}

function toPurchaseFacts(platform: PlatformId, raw: Record<string, unknown>): PurchaseFacts {
  const resourceUrl = optionalString(raw.resourceUrl);
  const method = optionalString(raw.method);
  const protocol = optionalString(raw.protocol);
  if (resourceUrl === undefined || method === undefined || protocol === undefined) {
    throw new CommerceError(
      "UPSTREAM_MALFORMED",
      `adapter ${platform} returned purchase facts without a resource URL, method or protocol`,
      { platform },
    );
  }
  return {
    platform,
    resourceUrl,
    method,
    protocol,
    network: stringOrNull(raw.network),
    asset: recordOrNull(raw.asset),
    price: recordOrNull(raw.price),
    payTo: stringOrNull(raw.payTo),
    ...(typeof raw.settlementNote === "string" ? { settlementNote: raw.settlementNote } : {}),
    ...(typeof raw.walletRequired === "boolean" ? { walletRequired: raw.walletRequired } : {}),
    ...(typeof raw.blockedReason === "string" ? { blockedReason: raw.blockedReason } : {}),
  };
}

function toClaimFacts(platform: PlatformId, raw: Record<string, unknown>): ClaimFacts {
  const title = optionalString(raw.title);
  if (title === undefined) {
    throw new CommerceError(
      "UPSTREAM_MALFORMED",
      `adapter ${platform} returned claim facts without a title`,
      { platform },
    );
  }
  return {
    platform,
    title,
    reward: recordOrNull(raw.reward) ?? {},
    funding: recordOrNull(raw.funding) ?? {},
    verification: recordOrNull(raw.verification) ?? {},
    requirements: stringArray(raw.requirements),
    externalStepsRequired: stringArray(raw.externalStepsRequired),
    paymentProofRule: stringOrNull(raw.paymentProofRule),
  };
}

/** Renders the shared "this did not happen" summary for any intent. */
function intentHuman(intent: CommerceIntent): string {
  return [
    `intent ${intent.id}`,
    `kind: ${intent.kind}   platform: ${intent.platform}   target: ${intent.targetId}`,
    `hash: ${intent.hash}`,
    `decision: ${intent.decision.decision} (${intent.decision.rule})`,
    `reason: ${intent.decision.reason ?? "none"}`,
    `required activation: ${intent.decision.requiredActivation ?? "none"}`,
    "financial action executed: false",
    "external mutation executed: false",
  ].join("\n");
}

async function commandPreparePurchase(ctx: RunContext): Promise<CommandResult> {
  const raw = requireTargetArgument(ctx, 2, "prepare purchase");
  const target = resolveTarget(ctx, raw);
  const adapter = adapterFor(ctx, target.platform);
  if (!adapter.capabilities().preparePurchase || adapter.preparePurchase === undefined) {
    throw new CommerceError(
      "UNSUPPORTED_OPERATION",
      `adapter ${target.platform} does not support purchase preparation`,
      { platform: target.platform },
    );
  }

  const prepare = adapter.preparePurchase.bind(adapter);
  const facts = await ctx.runAdapter(target.platform, (context) =>
    prepare(target.externalId, context),
  );

  const targetId = `${target.platform}:${target.externalId}`;
  const intent = preparePurchase(
    ctx.config,
    targetId,
    toPurchaseFacts(target.platform, facts),
    ctx.clock,
  );

  ctx.withRepo((repo) => {
    repo.savePolicyDecision(intent.decision);
    repo.saveIntent(intentToRecord(intent));
  });

  return {
    data: { target: targetId, canonicalId: target.canonicalId, intent },
    human: intentHuman(intent),
  };
}

async function commandPrepareClaim(ctx: RunContext): Promise<CommandResult> {
  const raw = requireTargetArgument(ctx, 2, "prepare claim");
  const target = resolveTarget(ctx, raw);
  const adapter = adapterFor(ctx, target.platform);
  if (!adapter.capabilities().prepareClaim || adapter.prepareClaim === undefined) {
    throw new CommerceError(
      "UNSUPPORTED_OPERATION",
      `adapter ${target.platform} does not support claim preparation`,
      { platform: target.platform },
    );
  }

  const prepare = adapter.prepareClaim.bind(adapter);
  const facts = await ctx.runAdapter(target.platform, (context) =>
    prepare(target.externalId, context),
  );

  const targetId = `${target.platform}:${target.externalId}`;
  const intent = prepareClaim(ctx.config, targetId, toClaimFacts(target.platform, facts), ctx.clock);

  ctx.withRepo((repo) => {
    repo.savePolicyDecision(intent.decision);
    repo.saveIntent(intentToRecord(intent));
  });

  return {
    data: { target: targetId, canonicalId: target.canonicalId, intent },
    human: intentHuman(intent),
  };
}

function commandPreparePublish(ctx: RunContext): CommandResult {
  const product = optionalString(ctx.positionals[2]);
  if (product === undefined) {
    throw new CommerceError(
      "INVALID_INPUT",
      `prepare publish requires a product; the only supported product is ${PRODUCT_NAME}`,
    );
  }
  if (product !== PRODUCT_NAME) {
    throw new CommerceError(
      "INVALID_INPUT",
      `unknown product ${JSON.stringify(product)}; the only supported product is ${PRODUCT_NAME}`,
      { product },
    );
  }

  const requestedTarget = optionalString(ctx.values.target);
  let targets: readonly PlatformId[];
  if (requestedTarget === undefined) {
    targets = PUBLISH_TARGETS;
  } else {
    const platform = asPlatformId(requestedTarget);
    if (platform === undefined || !(PUBLISH_TARGETS as readonly string[]).includes(platform)) {
      throw new CommerceError(
        "INVALID_INPUT",
        `--target must be one of ${PUBLISH_TARGETS.join(", ")}`,
        { target: requestedTarget },
      );
    }
    targets = [platform];
  }

  const readiness = inspectProfiler({ repoRoot: ctx.config.repoRoot });
  const manifest = buildProfilerManifest(readiness);
  if (!readiness.present) {
    ctx.warn(
      `product tree ${readiness.path} is absent under ${ctx.config.repoRoot}; ` +
        "readiness is reported as not ready",
    );
  }

  const intents = targets.map((platform) => {
    const target = readiness.targets[platform];
    return preparePublish(
      ctx.config,
      `${platform}:${PRODUCT_NAME}`,
      {
        platform,
        product: PRODUCT_NAME,
        version: readiness.version ?? "unknown",
        manifest,
        targetReady: target?.ready ?? false,
        reason: target?.reason ?? null,
      },
      ctx.clock,
    );
  });

  ctx.withRepo((repo) => {
    for (const intent of intents) {
      repo.savePolicyDecision(intent.decision);
      repo.saveIntent(intentToRecord(intent));
    }
  });

  const human = [
    `product ${PRODUCT_NAME} version ${readiness.version ?? "unknown"}`,
    `present: ${String(readiness.present)}   build ready: ${String(readiness.buildReady)}`,
    `publish intent ready: ${String(readiness.publishIntentReady)}`,
    "publication allowed: false   publication executed: false",
    ...(readiness.limitations.length === 0
      ? []
      : ["limitations:", ...readiness.limitations.map((l) => `  - ${l}`)]),
    "",
    ...intents.map((intent) => `  ${intent.platform.padEnd(12)} ${intent.id}  ${intent.decision.reason ?? ""}`),
  ].join("\n");

  return {
    data: { product: PRODUCT_NAME, readiness, manifest, intents },
    human,
  };
}

async function commandProbe(ctx: RunContext): Promise<CommandResult> {
  const startedAt = ctx.clock();
  ctx.note(`probing ${String(ctx.adapters.length)} adapters`);
  const probes = [...(await ctx.registry.probeAll())].sort((a, b) =>
    a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0,
  );

  for (const probe of probes) {
    if (probe.status === "degraded" || probe.status === "unreachable") {
      ctx.warn(
        `platform ${probe.platform} is ${probe.status}` +
          `${probe.errorCode === undefined ? "" : ` (${probe.errorCode})`}`,
      );
    }
  }

  ctx.withRepo((repo) => {
    for (const probe of probes) {
      repo.saveProbe(probe);
      repo.upsertSource(
        probe.platform,
        ctx.config.adapters[probe.platform].enabled,
        ctx.config.adapters[probe.platform].baseUrl,
        probe.status,
      );
    }
    recordOperation(
      repo,
      "probe",
      startedAt,
      ctx.clock(),
      Object.fromEntries(probes.map((p) => [p.platform, { status: p.status }])),
      probes.length,
    );
  });

  const data = {
    probes,
    summary: countBy(probes.map((p) => p.status)),
    degraded: probes.some((p) => p.status === "degraded" || p.status === "unreachable"),
    generatedAt: startedAt,
  };

  const human = [
    `probed ${String(probes.length)} platform(s)`,
    ...probes.map(
      (probe) =>
        `  ${probe.platform.padEnd(15)} ${probe.status.padEnd(12)} ` +
        `${probe.latencyMs === undefined ? "" : `${String(probe.latencyMs)}ms `}` +
        `${probe.errorCode ?? ""}`,
    ),
  ].join("\n");

  return { data, human };
}

function commandExport(ctx: RunContext): CommandResult {
  const exportedAt = ctx.clock();
  const artifacts = ctx.withRepo((repo) =>
    exportRepositoryOutputs({ config: ctx.config, repo, exportedAt }),
  );

  const human = [
    `wrote ${String(artifacts.length)} artifact(s) under ${ctx.config.repoRoot}`,
    ...artifacts.map(
      (artifact) =>
        `  ${artifact.path}  ${String(artifact.bytes)}B  ${artifact.sha256.slice(0, 16)}…`,
    ),
  ].join("\n");

  return { data: { repoRoot: ctx.config.repoRoot, artifacts, generatedAt: exportedAt }, human };
}

async function commandDoctor(ctx: RunContext): Promise<CommandResult> {
  const report = await runDoctor({
    config: ctx.config,
    env: ctx.env,
    adapterCount: ctx.adapters.length,
    clock: ctx.clock,
  });

  for (const check of report.checks) {
    if (check.status === "fail") ctx.warn(`doctor: ${check.id}: ${check.detail}`);
    else ctx.note(`doctor: ${check.id}: ${check.status}`);
  }

  const human = [
    `doctor: ${report.ok ? "healthy" : "UNHEALTHY"}`,
    `mode ${report.mode}   external writes: false   live value movement: false`,
    `wallet secret present: ${String(report.walletSecretPresent)}`,
    `node ${report.node.version}`,
    "",
    ...report.checks.map(
      (check) => `  ${check.status.toUpperCase().padEnd(4)} ${check.id.padEnd(30)} ${check.detail}`,
    ),
    "",
    `pass ${String(report.summary.pass)}  warn ${String(report.summary.warn)}  fail ${String(report.summary.fail)}`,
  ].join("\n");

  return { data: report, human, exitCode: report.ok ? EXIT_OK : EXIT_ERROR };
}

// -------------------------------------------------------------------- runner

const PARSE_OPTIONS = {
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  limit: { type: "string" },
  network: { type: "string" },
  protocol: { type: "string" },
  "max-usd-price": { type: "string" },
  "min-reward": { type: "string" },
  capability: { type: "string", multiple: true },
  "include-unearnable": { type: "boolean" },
  target: { type: "string" },
} as const;

/** Maps positionals onto a canonical command name, or undefined if unknown. */
function resolveCommand(positionals: readonly string[]): string | undefined {
  const head = positionals[0];
  if (head === undefined) return undefined;
  if (head === "discover" || head === "prepare") {
    const sub = positionals[1];
    if (sub === undefined) return undefined;
    const candidate = `${head} ${sub}`;
    return CLI_COMMANDS.includes(candidate) ? candidate : undefined;
  }
  return CLI_COMMANDS.includes(head) ? head : undefined;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const clock = deps.clock ?? ((): string => new Date().toISOString());
  const env = deps.env ?? process.env;

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (error) {
    // A bad option is a usage problem, so it must not be reported as a runtime
    // failure a caller might retry.
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\nRun "commerce --help" for the command surface.\n`);
    return EXIT_USAGE;
  }

  const json = values.json === true;
  const verbose = values.verbose === true;

  const emitError = (command: string, error: CommerceError, exitCode: number): number => {
    const envelope: Envelope = {
      ok: false,
      command,
      mode: APP_MODE,
      version: APP_VERSION,
      generatedAt: clock(),
      financialActionExecuted: false,
      externalMutationExecuted: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
    if (json) io.stdout(`${JSON.stringify(envelope)}\n`);
    io.stderr(`${error.message}\n`);
    return exitCode;
  };

  if (values.version === true) {
    io.stdout(`${APP_VERSION}\n`);
    return EXIT_OK;
  }
  if (values.help === true || positionals.length === 0) {
    io.stdout(HELP);
    return positionals.length === 0 && values.help !== true ? EXIT_USAGE : EXIT_OK;
  }

  const command = resolveCommand(positionals);
  if (command === undefined) {
    const attempted = positionals.slice(0, 2).join(" ");
    return emitError(
      positionals[0] ?? "unknown",
      new CommerceError(
        "INVALID_INPUT",
        `unknown command ${JSON.stringify(attempted)}. Supported: ${CLI_COMMANDS.join(", ")}`,
        { attempted },
      ),
      EXIT_USAGE,
    );
  }

  // Config load is where Mode-A activation attempts fail closed.
  let config: CommerceConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    return emitError(command, asCommerceError(error, "CONFIG_ERROR"), EXIT_ERROR);
  }

  const adapters = deps.adapters ?? defaultAdapters(config);
  const registryOptions: RegistryOptions = deps.registryOptions ?? { clock };
  const registry = new AdapterRegistry(config, adapters, registryOptions);
  const byId = new Map<PlatformId, CommerceAdapter>(adapters.map((a) => [a.id, a]));

  const ctx: RunContext = {
    config,
    env,
    clock,
    adapters,
    registry,
    byId,
    values,
    positionals,
    warn: (message: string): void => {
      io.stderr(`warning: ${message}\n`);
    },
    note: (message: string): void => {
      if (verbose) io.stderr(`note: ${message}\n`);
    },
    withRepo: <T,>(fn: (repo: CommerceRepository) => T): T => {
      const db = openStateDatabase(config.databasePath);
      try {
        runMigrations(db);
        return fn(new CommerceRepository(db));
      } finally {
        closeStateDatabase(db);
      }
    },
    runAdapter: async <T,>(
      platform: PlatformId,
      fn: (context: AdapterContext) => Promise<T>,
    ): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.network.adapterBudgetMs);
      try {
        return await fn(registry.contextFor(platform, controller.signal));
      } finally {
        clearTimeout(timer);
      }
    },
  };

  try {
    const result = await dispatch(command, ctx);
    if (json) {
      const envelope: Envelope = {
        ok: true,
        command,
        mode: APP_MODE,
        version: APP_VERSION,
        generatedAt: clock(),
        financialActionExecuted: false,
        externalMutationExecuted: false,
        data: result.data,
      };
      io.stdout(`${JSON.stringify(envelope)}\n`);
    } else {
      io.stdout(`${result.human}\n`);
    }
    return result.exitCode ?? EXIT_OK;
  } catch (error) {
    const typed = asCommerceError(error, "STATE_ERROR");
    // A malformed invocation is a usage error even when it surfaces mid-command.
    const exitCode = typed.code === "INVALID_INPUT" ? EXIT_USAGE : EXIT_ERROR;
    return emitError(command, typed, exitCode);
  }
}

async function dispatch(command: string, ctx: RunContext): Promise<CommandResult> {
  switch (command) {
    case "sources":
      return commandSources(ctx);
    case "status":
      return commandStatus(ctx);
    case "discover services":
      return commandDiscoverServices(ctx);
    case "discover work":
      return commandDiscoverWork(ctx);
    case "inspect":
      return commandInspect(ctx);
    case "quote":
      return commandQuote(ctx);
    case "prepare purchase":
      return commandPreparePurchase(ctx);
    case "prepare claim":
      return commandPrepareClaim(ctx);
    case "prepare publish":
      return commandPreparePublish(ctx);
    case "probe":
      return commandProbe(ctx);
    case "export":
      return commandExport(ctx);
    case "doctor":
      return commandDoctor(ctx);
    default:
      throw new CommerceError("INVALID_INPUT", `unhandled command ${JSON.stringify(command)}`);
  }
}

/** True when this module is the process entrypoint rather than an import. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (chunk: string): void => {
      process.stdout.write(chunk);
    },
    stderr: (chunk: string): void => {
      process.stderr.write(chunk);
    },
  });
  process.exitCode = code;
}
