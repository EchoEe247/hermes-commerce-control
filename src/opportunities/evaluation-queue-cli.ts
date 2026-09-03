#!/usr/bin/env node
/**
 * Provider-neutral evaluation queue preparation CLI.
 *
 * Reads persisted opportunities, re-runs deterministic triage, and emits bounded
 * evaluation packets/prompts. It performs no network request and no model call.
 */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { prepareOpportunityEvaluationQueue } from "./evaluation-queue.js";
import { OPPORTUNITY_PROFILE_IDS, resolveOpportunityProfile } from "./profiles.js";
import { JsonlOpportunityStore } from "./store.js";
import {
  OPPORTUNITY_TRIAGE_DECISIONS,
  type OpportunityTriageDecision,
} from "./triage.js";

const HELP = `Prepare opportunity evaluation queue

Usage:
  node --import tsx src/opportunities/evaluation-queue-cli.ts [options]

Options:
      --profile <name>       ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --decision <name>      candidate | review | reject | all (repeatable)
      --min-score <0-100>    minimum deterministic triage score (default: 0)
      --limit <n>            max prepared requests (default: 50)
      --scan-limit <n>       max persisted rows to inspect (default: 1000)
      --state-file <path>    opportunity JSONL store
      --json                 emit one JSON document containing the queue
      --jsonl                emit one prepared request per JSON line
      --help

Default decisions are candidate + review. Each request contains a bounded packet,
stable request ID, and provider-neutral prompt. This command does not call a model,
spend provider quota, access secrets, contact anyone, or perform an external write.
`;

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function score(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("--min-score must be a number from 0 to 100");
  }
  return value;
}

function decisions(raw: readonly string[] | undefined): readonly OpportunityTriageDecision[] {
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
      "min-score": { type: "string" },
      limit: { type: "string" },
      "scan-limit": { type: "string" },
      "state-file": { type: "string" },
      json: { type: "boolean", default: false },
      jsonl: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }
  if (values.json === true && values.jsonl === true) {
    throw new Error("--json and --jsonl are mutually exclusive");
  }

  const config = loadConfig(process.env);
  const stateFile = resolve(values["state-file"] ?? join(config.stateRoot, "opportunities.jsonl"));
  const profile = resolveOpportunityProfile(values.profile ?? process.env.OPPORTUNITY_PROFILE);
  const selectedDecisions = decisions(values.decision);
  const minimumScore = score(values["min-score"]);
  const limit = positiveInt(values.limit, "limit", 50);
  const scanLimit = positiveInt(values["scan-limit"], "scan-limit", 1_000);
  const queue = await prepareOpportunityEvaluationQueue(
    new JsonlOpportunityStore(stateFile),
    profile.triage,
    { decisions: selectedDecisions, minimumScore, limit, scanLimit },
  );

  if (values.jsonl === true) {
    for (const item of queue) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }

  const output = {
    ok: true,
    mode: "prepare-only",
    stateFile,
    profile: profile.id,
    decisions: selectedDecisions,
    minimumScore,
    count: queue.length,
    queue,
  };
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Opportunity evaluation queue: ${String(queue.length)} request(s)`,
      `profile: ${profile.id}`,
      `decisions: ${selectedDecisions.join(", ")}`,
      `min score: ${String(minimumScore)}`,
      `state: ${stateFile}`,
      ...queue.map(
        (item) =>
          `- ${item.requestId} [${item.triageDecision} ${String(item.triageScore)}] ${item.packet.opportunity.title}`,
      ),
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`evaluation queue preparation failed: ${message}\n`);
  process.exitCode = 1;
});
