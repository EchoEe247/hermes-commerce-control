#!/usr/bin/env node
/**
 * Offline opportunity review CLI.
 *
 * Re-evaluates already-persisted discovery signals with deterministic triage.
 * No network access, Reddit request, model call, or external write occurs.
 */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import {
  OPPORTUNITY_PROFILE_IDS,
  resolveOpportunityProfile,
} from "./profiles.js";
import { reviewStoredOpportunities } from "./review.js";
import { JsonlOpportunityStore } from "./store.js";
import {
  OPPORTUNITY_TRIAGE_DECISIONS,
  type OpportunityTriageDecision,
} from "./triage.js";

const HELP = `Offline opportunity review

Usage:
  node --import tsx src/opportunities/review-cli.ts [options]

Options:
      --profile <name>       ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --decision <name>      candidate | review | reject | all (repeatable)
      --limit <n>            max rows to return (default: 100)
      --scan-limit <n>       max persisted rows to inspect (default: 1000)
      --state-file <path>    opportunity JSONL store
      --json                 emit one JSON document
      --help

Default decisions are candidate + review. This command is offline: it reads only
persisted opportunity state and can therefore recover/re-rank listings after a
watcher run even if its original terminal output was missed.
`;

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function parseDecisions(raw: readonly string[] | undefined): readonly OpportunityTriageDecision[] {
  if (raw === undefined || raw.length === 0) return ["candidate", "review"];
  if (raw.some((value) => value.trim().toLowerCase() === "all")) {
    return OPPORTUNITY_TRIAGE_DECISIONS;
  }
  const out: OpportunityTriageDecision[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (!(OPPORTUNITY_TRIAGE_DECISIONS as readonly string[]).includes(normalized)) {
      throw new Error(`invalid --decision ${JSON.stringify(value)}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized as OpportunityTriageDecision);
  }
  return Object.freeze(out);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: "string" },
      decision: { type: "string", multiple: true },
      limit: { type: "string" },
      "scan-limit": { type: "string" },
      "state-file": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig(process.env);
  const stateFile = resolve(values["state-file"] ?? join(config.stateRoot, "opportunities.jsonl"));
  const profile = resolveOpportunityProfile(values.profile ?? process.env.OPPORTUNITY_PROFILE);
  const decisions = parseDecisions(values.decision);
  const limit = parsePositiveInt(values.limit, "limit", 100);
  const scanLimit = parsePositiveInt(values["scan-limit"], "scan-limit", 1_000);
  const store = new JsonlOpportunityStore(stateFile);
  const entries = await reviewStoredOpportunities(store, profile.triage, {
    decisions,
    limit,
    scanLimit,
  });

  const output = {
    ok: true,
    mode: "offline-review",
    stateFile,
    profile: profile.id,
    decisions,
    count: entries.length,
    entries,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Opportunity review: ${String(entries.length)} row(s)`,
      `profile: ${profile.id}`,
      `decisions: ${decisions.join(", ")}`,
      `state: ${stateFile}`,
      ...entries.map(({ opportunity, triage }) =>
        `- [${triage.decision} ${String(triage.score)}] ` +
        `${opportunity.community === undefined ? opportunity.source : `r/${opportunity.community}`}: ` +
        `${opportunity.title}${opportunity.url === undefined ? "" : ` — ${opportunity.url}`}`,
      ),
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opportunity review failed: ${message}\n`);
  process.exitCode = 1;
});
