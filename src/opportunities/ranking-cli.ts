#!/usr/bin/env node
/** Offline ranked opportunity queue. No network/model/external mutation. */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { JsonlOpportunityEvaluationResultStore } from "./evaluation-results.js";
import { OPPORTUNITY_PROFILE_IDS, resolveOpportunityProfile } from "./profiles.js";
import {
  DEFAULT_RANKING_MAX_AGE_HOURS,
  OPPORTUNITY_OPERATOR_ACTIONS,
  rankStoredOpportunities,
  type OpportunityOperatorAction,
  type RankedOpportunity,
} from "./ranking.js";
import { JsonlOpportunityStore } from "./store.js";

const DEFAULT_ACTIONS = Object.freeze([
  "review_for_pursuit",
  "manual_review",
  "watch",
] as const);

const HELP = `Rank evaluated opportunities offline

Usage:
  node --import tsx src/opportunities/ranking-cli.ts [options]

Options:
      --profile <name>          ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --evaluator <id>          only use evaluations from this exact evaluator ID
      --action <name>           review_for_pursuit | manual_review | watch | reject | all (repeatable)
      --min-score <0-100>       minimum deterministic rank score (default: 0)
      --max-age-hours <n>       max age for non-rejected listing/evaluation state (default: ${String(DEFAULT_RANKING_MAX_AGE_HOURS)}; 0 disables)
      --as-of <timestamp>       ranking clock for deterministic replay (default: now)
      --limit <n>               max ranked rows (default: 25)
      --scan-limit <n>          max persisted opportunities to inspect (default: 1000)
      --state-file <path>       opportunity JSONL store
      --evaluation-file <path>  evaluation-result JSONL store
      --json                    emit one JSON document
      --help

By default rejected rows are hidden. Ranking is offline: it performs no Reddit
request, model call, contact, claim, submission, hiring action, or payment.
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

function maxAgeHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RANKING_MAX_AGE_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--max-age-hours must be a non-negative number");
  }
  return value;
}

function asOfTimestamp(raw: string | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  if (!Number.isFinite(Date.parse(raw))) throw new Error("--as-of must be a valid timestamp");
  return raw;
}

function actions(raw: readonly string[] | undefined): readonly OpportunityOperatorAction[] {
  if (raw === undefined || raw.length === 0) return DEFAULT_ACTIONS;
  if (raw.some((value) => value.trim().toLowerCase() === "all")) {
    return OPPORTUNITY_OPERATOR_ACTIONS;
  }
  const out: OpportunityOperatorAction[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (!(OPPORTUNITY_OPERATOR_ACTIONS as readonly string[]).includes(normalized)) {
      throw new Error(`invalid --action ${JSON.stringify(value)}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized as OpportunityOperatorAction);
  }
  return Object.freeze(out);
}

function countBy<T extends string>(values: readonly T[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.freeze(counts);
}

function compact(entry: RankedOpportunity, index: number): Readonly<Record<string, unknown>> {
  const evaluation = entry.evaluationRecord.evaluation;
  return Object.freeze({
    rank: index + 1,
    score: entry.score,
    priorityBand: entry.priorityBand,
    operatorAction: entry.operatorAction,
    executionRoute: entry.executionRoute,
    evaluationFreshness: entry.evaluationFreshness,
    currentRequestId: entry.currentRequestId,
    opportunity: {
      id: entry.opportunity.id,
      title: entry.opportunity.title,
      ...(entry.opportunity.community === undefined ? {} : { community: entry.opportunity.community }),
      ...(entry.opportunity.url === undefined ? {} : { url: entry.opportunity.url }),
      ...(entry.opportunity.postedAt === undefined ? {} : { postedAt: entry.opportunity.postedAt }),
      observedAt: entry.opportunity.observedAt,
    },
    triage: {
      decision: entry.triage.decision,
      score: entry.triage.score,
      ...(entry.triage.signals.budget === undefined ? {} : { budget: entry.triage.signals.budget }),
      cautionFlags: entry.triage.cautionFlags,
    },
    evaluation: {
      requestId: entry.evaluationRecord.requestId,
      evaluatorId: entry.evaluationRecord.evaluatorId,
      evaluatedAt: entry.evaluationRecord.evaluatedAt,
      recommendation: evaluation.recommendation,
      risk: evaluation.risk,
      confidence: evaluation.confidence,
      estimatedEffortMinutes: evaluation.estimatedEffortMinutes,
      economics: evaluation.economics,
      capabilities: evaluation.capabilities,
      reasons: evaluation.reasons,
      blockers: evaluation.blockers,
      nextChecks: evaluation.nextChecks,
    },
    scoreComponents: entry.components,
    routingReasons: entry.routingReasons,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: "string" },
      evaluator: { type: "string" },
      action: { type: "string", multiple: true },
      "min-score": { type: "string" },
      "max-age-hours": { type: "string" },
      "as-of": { type: "string" },
      limit: { type: "string" },
      "scan-limit": { type: "string" },
      "state-file": { type: "string" },
      "evaluation-file": { type: "string" },
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
  const evaluationFile = resolve(
    values["evaluation-file"] ?? join(config.stateRoot, "opportunity-evaluations.jsonl"),
  );
  const profile = resolveOpportunityProfile(values.profile ?? process.env.OPPORTUNITY_PROFILE);
  const selectedActions = actions(values.action);
  const minimumScore = score(values["min-score"]);
  const selectedMaxAgeHours = maxAgeHours(values["max-age-hours"]);
  const asOf = asOfTimestamp(values["as-of"]);
  const limit = positiveInt(values.limit, "limit", 25);
  const scanLimit = positiveInt(values["scan-limit"], "scan-limit", 1_000);
  const evaluatorId = values.evaluator?.trim() || process.env.OPPORTUNITY_EVALUATOR_ID?.trim();

  const ranked = await rankStoredOpportunities(
    new JsonlOpportunityStore(stateFile),
    new JsonlOpportunityEvaluationResultStore(evaluationFile),
    profile.triage,
    {
      ...(evaluatorId === undefined || evaluatorId === "" ? {} : { evaluatorId }),
      actions: selectedActions,
      minimumScore,
      maxAgeHours: selectedMaxAgeHours,
      asOf,
      limit,
      scanLimit,
    },
  );
  const rows = ranked.map(compact);
  const output = {
    ok: true,
    mode: "offline-ranking",
    profile: profile.id,
    evaluatorId: evaluatorId ?? null,
    actions: selectedActions,
    minimumScore,
    maxAgeHours: selectedMaxAgeHours,
    asOf,
    stateFile,
    evaluationFile,
    count: ranked.length,
    counts: {
      byAction: countBy(ranked.map((entry) => entry.operatorAction)),
      byExecutionRoute: countBy(ranked.map((entry) => entry.executionRoute)),
      byPriorityBand: countBy(ranked.map((entry) => entry.priorityBand)),
      byEvaluationFreshness: countBy(ranked.map((entry) => entry.evaluationFreshness)),
    },
    ranked: rows,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Ranked opportunity queue: ${String(ranked.length)} row(s)`,
      `profile: ${profile.id}`,
      `evaluator: ${evaluatorId ?? "latest current evaluation per opportunity"}`,
      `max age: ${String(selectedMaxAgeHours)}h${selectedMaxAgeHours === 0 ? " (disabled)" : ""}`,
      `actions: ${selectedActions.join(", ")}`,
      ...ranked.map(
        (entry, index) =>
          `${String(index + 1)}. [${String(entry.score)} ${entry.priorityBand} ${entry.operatorAction}/${entry.executionRoute} ${entry.evaluationFreshness}] ${entry.opportunity.title}`,
      ),
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opportunity ranking failed: ${message}\n`);
  process.exitCode = 1;
});
