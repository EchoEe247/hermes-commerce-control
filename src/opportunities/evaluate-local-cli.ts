#!/usr/bin/env node
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { prepareOpportunityEvaluationQueue } from "./evaluation-queue.js";
import { JsonlOpportunityEvaluationResultStore } from "./evaluation-results.js";
import { runPreparedOpportunityEvaluations } from "./evaluation-runner.js";
import { LocalOpenAiOpportunityEvaluator } from "./local-openai-evaluator.js";
import { OPPORTUNITY_PROFILE_IDS, resolveOpportunityProfile } from "./profiles.js";
import { JsonlOpportunityStore } from "./store.js";
import {
  OPPORTUNITY_TRIAGE_DECISIONS,
  type OpportunityTriageDecision,
} from "./triage.js";

const HELP = `Evaluate persisted opportunities through a loopback OpenAI-compatible endpoint

Usage:
  node --import tsx src/opportunities/evaluate-local-cli.ts [options]

Required runtime configuration:
      --base-url <url>        loopback OpenAI-compatible base URL, e.g. http://127.0.0.1:20130/v1
      --model <id>            model ID exposed by that local endpoint

Selection:
      --profile <name>        ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --decision <name>      candidate | review | reject | all (repeatable)
      --min-score <0-100>    minimum deterministic score (default: 0)
      --limit <n>            max prepared requests (default: 5)
      --scan-limit <n>       max persisted opportunities scanned (default: 1000)

State/output:
      --state-file <path>    opportunity JSONL state
      --results-file <path>  evaluation JSONL state
      --timeout-ms <n>       per-model-call timeout (default: 120000)
      --json                 emit one JSON document
      --help

Environment fallbacks:
  OPPORTUNITY_EVALUATOR_BASE_URL
  OPPORTUNITY_EVALUATOR_MODEL

Safety: this command only accepts an explicit HTTP loopback endpoint, carries no API key,
sends no Authorization/Cookie header, does not contact opportunity posters, and performs
no claim/submission/payment action. Completed request+evaluator pairs are persisted and
skipped on rerun so free model quota is not spent twice on identical work.
`;

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function minScore(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("--min-score must be from 0 to 100");
  }
  return value;
}

function decisions(raw: readonly string[] | undefined): readonly OpportunityTriageDecision[] {
  if (raw === undefined || raw.length === 0) return ["candidate", "review"];
  if (raw.some((value) => value.trim().toLowerCase() === "all")) return OPPORTUNITY_TRIAGE_DECISIONS;
  const out: OpportunityTriageDecision[] = [];
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (!(OPPORTUNITY_TRIAGE_DECISIONS as readonly string[]).includes(normalized)) {
      throw new Error(`invalid --decision ${JSON.stringify(value)}`);
    }
    if (!out.includes(normalized as OpportunityTriageDecision)) {
      out.push(normalized as OpportunityTriageDecision);
    }
  }
  return Object.freeze(out);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      "base-url": { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      decision: { type: "string", multiple: true },
      "min-score": { type: "string" },
      limit: { type: "string" },
      "scan-limit": { type: "string" },
      "state-file": { type: "string" },
      "results-file": { type: "string" },
      "timeout-ms": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const baseUrl = values["base-url"] ?? process.env.OPPORTUNITY_EVALUATOR_BASE_URL;
  const model = values.model ?? process.env.OPPORTUNITY_EVALUATOR_MODEL;
  if (baseUrl === undefined || baseUrl.trim() === "") throw new Error("--base-url is required");
  if (model === undefined || model.trim() === "") throw new Error("--model is required");

  const config = loadConfig(process.env);
  const stateFile = resolve(values["state-file"] ?? join(config.stateRoot, "opportunities.jsonl"));
  const resultsFile = resolve(
    values["results-file"] ?? join(config.stateRoot, "opportunity-evaluations.jsonl"),
  );
  const selectedDecisions = decisions(values.decision);
  const profile = resolveOpportunityProfile(values.profile ?? process.env.OPPORTUNITY_PROFILE);
  const limit = positiveInt(values.limit, "limit", 5);
  const scanLimit = positiveInt(values["scan-limit"], "scan-limit", 1_000);
  const timeoutMs = positiveInt(values["timeout-ms"], "timeout-ms", 120_000);

  const queue = await prepareOpportunityEvaluationQueue(
    new JsonlOpportunityStore(stateFile),
    profile.triage,
    {
      decisions: selectedDecisions,
      minimumScore: minScore(values["min-score"]),
      limit,
      scanLimit,
    },
  );
  const evaluator = new LocalOpenAiOpportunityEvaluator({ baseUrl, model, timeoutMs });
  const results = await runPreparedOpportunityEvaluations(
    queue,
    evaluator,
    new JsonlOpportunityEvaluationResultStore(resultsFile),
  );

  const counts = { completed: 0, skipped: 0, failed: 0 };
  for (const result of results) counts[result.status] += 1;
  const ok = counts.failed === 0;
  const output = {
    ok,
    mode: "local-evaluation",
    evaluator: evaluator.id,
    stateFile,
    resultsFile,
    profile: profile.id,
    decisions: selectedDecisions,
    queueCount: queue.length,
    counts,
    results,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!ok) process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`local opportunity evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
