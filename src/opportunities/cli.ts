#!/usr/bin/env node
/**
 * Minimal read-only opportunity watcher entry point.
 *
 * Development:
 *   node --import tsx src/opportunities/cli.ts --subreddit forhire --subreddit slavelabour
 *
 * Built:
 *   node dist/opportunities/cli.js --subreddit forhire --subreddit slavelabour
 *
 * It performs no Reddit login, OAuth, posting, commenting, messaging, or paid API
 * call. The only write is the local JSONL seen/opportunity store.
 */
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createSafeFetch } from "../network/safe-fetch.js";
import { RedditRssOpportunityAdapter } from "./adapters/reddit-rss.js";
import { OpportunityIngestor } from "./ingest.js";
import { discoverAndPersist } from "./pipeline.js";
import { JsonlOpportunityStore } from "./store.js";
import {
  extendOpportunityProfile,
  OPPORTUNITY_PROFILE_IDS,
  resolveOpportunityProfile,
} from "./profiles.js";
import { summarizeOpportunitySourceHealth } from "./runtime-health.js";
import {
  triageOpportunities,
  type OpportunityTriageProfile,
  type OpportunityTriageResult,
} from "./triage.js";

const HELP = `Permanent-free Reddit opportunity watcher

Usage:
  node --import tsx src/opportunities/cli.ts [options]

Source options:
  -s, --subreddit <name>      subreddit to watch (repeatable)
  -q, --query <text>          local title/body substring filter
      --limit <n>             max new results returned from the feed
      --state-file <path>     JSONL store (default: <COMMERCE_STATE_ROOT>/opportunities.jsonl)

Zero-cost triage options:
      --profile <name>        ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --prefer-term <text>    positive-fit phrase (repeatable; adds to profile)
      --exclude-term <text>   hard-exclusion phrase (repeatable; adds to profile)
      --require-demand        reject explicit [FOR HIRE]/[OFFER]-style seller posts
      --require-remote        reject explicitly local/in-person listings
      --min-fixed-usd <n>     reject known fixed-price listings below this USD amount

Output:
      --json                  emit one JSON document
      --help

Environment fallbacks:
  OPPORTUNITY_REDDIT_SUBREDDITS=forhire,slavelabour
  OPPORTUNITY_PROFILE=demand
  OPPORTUNITY_PREFERRED_TERMS=automation,api integration,crm
  OPPORTUNITY_EXCLUDED_TERMS=survey,physical pickup
  OPPORTUNITY_REQUIRE_DEMAND=true
  OPPORTUNITY_REQUIRE_REMOTE=true
  OPPORTUNITY_MIN_FIXED_USD=25

The default demand profile filters explicit seller/service-offer posts but keeps
both remote and physical buyer tasks. Use --profile all to disable that default,
--profile remote-demand for online-only work, or an automation profile to boost
workflow/API/CRM-style opportunities without hiding other demand-side work.

Triage is deterministic and conservative. Caution signals are not fraud verdicts;
ambiguous listings remain reviewable for a later model/human evaluator.

The source is Reddit's public Atom/RSS feed. RSS is treated as a replaceable
adapter, not a guaranteed long-term dependency. A pass exits non-zero when no
configured source completes successfully, so an outage cannot masquerade as an
empty healthy feed.
`;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error("--limit must be a positive integer");
  return Math.min(100, value);
}

function parseNonNegativeMoney(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return Math.round(value * 100) / 100;
}

function envCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function envBoolean(name: string): boolean {
  return new Set(["1", "true", "yes", "on"]).has((process.env[name] ?? "").trim().toLowerCase());
}

function countTriage(results: readonly OpportunityTriageResult[]): Readonly<Record<string, number>> {
  const counts = { candidate: 0, review: 0, reject: 0 };
  for (const result of results) counts[result.decision] += 1;
  return Object.freeze(counts);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      subreddit: { type: "string", short: "s", multiple: true },
      query: { type: "string", short: "q" },
      limit: { type: "string" },
      "state-file": { type: "string" },
      profile: { type: "string" },
      "prefer-term": { type: "string", multiple: true },
      "exclude-term": { type: "string", multiple: true },
      "require-demand": { type: "boolean", default: false },
      "require-remote": { type: "boolean", default: false },
      "min-fixed-usd": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const subreddits = values.subreddit ?? envCsv("OPPORTUNITY_REDDIT_SUBREDDITS");
  if (subreddits.length === 0) {
    throw new Error(
      "no subreddits configured; pass --subreddit or set OPPORTUNITY_REDDIT_SUBREDDITS",
    );
  }

  const config = loadConfig(process.env);
  const stateFile = resolve(values["state-file"] ?? join(config.stateRoot, "opportunities.jsonl"));
  const safeFetch = createSafeFetch(config, {
    userAgent: "hermes-commerce-control/0.1.0 opportunity-rss (read-only)",
  });
  const adapter = new RedditRssOpportunityAdapter({ subreddits });
  const ingestor = new OpportunityIngestor(safeFetch, [adapter], {
    adapterBudgetMs: config.network.adapterBudgetMs,
    concurrency: config.concurrency,
  });
  const store = new JsonlOpportunityStore(stateFile);
  const limit = parseLimit(values.limit);
  const result = await discoverAndPersist(ingestor, store, {
    ...(values.query === undefined ? {} : { q: values.query }),
    ...(limit === undefined ? {} : { limit }),
  });
  const sourceHealth = summarizeOpportunitySourceHealth(result.sources);

  const namedProfile = resolveOpportunityProfile(values.profile ?? process.env.OPPORTUNITY_PROFILE);
  const preferredTerms = values["prefer-term"] ?? envCsv("OPPORTUNITY_PREFERRED_TERMS");
  const excludedTerms = values["exclude-term"] ?? envCsv("OPPORTUNITY_EXCLUDED_TERMS");
  const minimumKnownFixedUsd = parseNonNegativeMoney(
    values["min-fixed-usd"] ?? process.env.OPPORTUNITY_MIN_FIXED_USD,
    "min-fixed-usd",
  );
  const explicitProfile: OpportunityTriageProfile = {
    ...(preferredTerms.length === 0 ? {} : { preferredTerms }),
    ...(excludedTerms.length === 0 ? {} : { excludedTerms }),
    ...(values["require-demand"] === true || envBoolean("OPPORTUNITY_REQUIRE_DEMAND")
      ? { requireDemand: true }
      : {}),
    ...(values["require-remote"] === true || envBoolean("OPPORTUNITY_REQUIRE_REMOTE")
      ? { requireRemote: true }
      : {}),
    ...(minimumKnownFixedUsd === undefined ? {} : { minimumKnownFixedUsd }),
  };
  const triageProfile = extendOpportunityProfile(namedProfile.triage, explicitProfile);
  const triage = triageOpportunities(result.results, triageProfile);
  const triageCounts = countTriage(triage);
  const triageById = new Map(triage.map((entry) => [entry.opportunityId, entry] as const));

  const output = {
    ok: sourceHealth.ok,
    mode: "read-only",
    source: "reddit_rss",
    subreddits,
    stateFile,
    count: result.results.length,
    persisted: result.persisted,
    duplicatesDropped: result.duplicatesDropped,
    sourceHealth,
    sources: result.sources,
    profile: namedProfile.id,
    triageProfile,
    triageCounts,
    triage,
    results: result.results,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (!sourceHealth.ok) process.exitCode = 2;
    return;
  }

  process.stdout.write(
    [
      `Reddit RSS opportunity pass: ${String(result.results.length)} new, ` +
        `${String(result.duplicatesDropped)} duplicate(s) dropped`,
      `source health: ${sourceHealth.ok ? (sourceHealth.degraded ? "degraded" : "ok") : "failed"}`,
      ...(sourceHealth.failedSources.length === 0
        ? []
        : [`failed sources: ${sourceHealth.failedSources.join(", ")}`]),
      `profile: ${namedProfile.id}`,
      `triage: ${String(triageCounts.candidate ?? 0)} candidate, ` +
        `${String(triageCounts.review ?? 0)} review, ${String(triageCounts.reject ?? 0)} reject`,
      `watched: ${subreddits.map((value) => `r/${value.replace(/^r\//i, "")}`).join(", ")}`,
      `state: ${stateFile}`,
      ...result.results.map((candidate) => {
        const decision = triageById.get(candidate.id);
        const prefix = decision === undefined ? "untriaged" : `${decision.decision} ${String(decision.score)}`;
        return (
          `- [${prefix}] ${candidate.community === undefined ? "reddit" : `r/${candidate.community}`}: ` +
          `${candidate.title}${candidate.url === undefined ? "" : ` — ${candidate.url}`}`
        );
      }),
    ].join("\n") + "\n",
  );
  if (!sourceHealth.ok) process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opportunity watcher failed: ${message}\n`);
  process.exitCode = 1;
});
