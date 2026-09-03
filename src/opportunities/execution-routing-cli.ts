#!/usr/bin/env node
/** Offline execution routing. No contact, posting, hiring, acceptance, or payment. */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { JsonlOpportunityEvaluationResultStore } from "./evaluation-results.js";
import {
  buildOpportunityExecutionPlans,
  OPPORTUNITY_EXECUTION_DECISIONS,
  type OpportunityExecutionDecision,
} from "./execution-routing.js";
import { OPPORTUNITY_PROFILE_IDS, resolveOpportunityProfile } from "./profiles.js";
import { DEFAULT_RANKING_MAX_AGE_HOURS, rankStoredOpportunities } from "./ranking.js";
import { JsonlOpportunityStore } from "./store.js";

const HELP = `Route evaluated opportunities into execution paths

Usage:
  node --import tsx src/opportunities/execution-routing-cli.ts [options]

Options:
      --profile <name>          ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --evaluator <id>          only use evaluations from this exact evaluator ID
      --decision <name>         ${OPPORTUNITY_EXECUTION_DECISIONS.join(" | ")} | all (repeatable)
      --min-score <0-100>       minimum deterministic rank score (default: 0)
      --max-age-hours <n>       max age for non-rejected state (default: ${String(DEFAULT_RANKING_MAX_AGE_HOURS)}; 0 disables)
      --as-of <timestamp>       deterministic ranking clock (default: now)
      --limit <n>               max ranked rows to route (default: 25)
      --scan-limit <n>          max persisted opportunities to inspect (default: 1000)
      --state-file <path>       opportunity JSONL store
      --evaluation-file <path>  evaluation-result JSONL store
      --json                    emit one JSON document
      --help

This command is analysis-only. Human fulfillment plans do not post jobs, contact
workers, promise compensation, accept deliverables, or move money.
`;

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function minimumScore(raw: string | undefined): number {
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

function decisions(raw: readonly string[] | undefined): ReadonlySet<OpportunityExecutionDecision> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw.some((value) => value.trim().toLowerCase() === "all")) return undefined;
  const selected = new Set<OpportunityExecutionDecision>();
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (!(OPPORTUNITY_EXECUTION_DECISIONS as readonly string[]).includes(normalized)) {
      throw new Error(`invalid --decision ${JSON.stringify(value)}`);
    }
    selected.add(normalized as OpportunityExecutionDecision);
  }
  return selected;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.freeze(out);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: "string" },
      evaluator: { type: "string" },
      decision: { type: "string", multiple: true },
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
  const evaluatorId = values.evaluator?.trim() || process.env.OPPORTUNITY_EVALUATOR_ID?.trim();
  const score = minimumScore(values["min-score"]);
  const selectedMaxAgeHours = maxAgeHours(values["max-age-hours"]);
  const asOf = asOfTimestamp(values["as-of"]);
  const limit = positiveInt(values.limit, "limit", 25);
  const scanLimit = positiveInt(values["scan-limit"], "scan-limit", 1_000);
  const decisionFilter = decisions(values.decision);

  const ranked = await rankStoredOpportunities(
    new JsonlOpportunityStore(stateFile),
    new JsonlOpportunityEvaluationResultStore(evaluationFile),
    profile.triage,
    {
      ...(evaluatorId === undefined || evaluatorId === "" ? {} : { evaluatorId }),
      actions: ["review_for_pursuit", "manual_review", "watch"],
      minimumScore: score,
      maxAgeHours: selectedMaxAgeHours,
      asOf,
      limit,
      scanLimit,
    },
  );

  const plans = buildOpportunityExecutionPlans(ranked).filter(
    (plan) => decisionFilter === undefined || decisionFilter.has(plan.decision),
  );

  const output = {
    ok: true,
    mode: "offline-execution-routing",
    profile: profile.id,
    evaluatorId: evaluatorId ?? null,
    minimumScore: score,
    maxAgeHours: selectedMaxAgeHours,
    asOf,
    stateFile,
    evaluationFile,
    count: plans.length,
    counts: {
      byDecision: countBy(plans.map((plan) => plan.decision)),
      byHumanKind: countBy(
        plans.flatMap((plan) =>
          plan.humanFulfillment === null ? [] : [plan.humanFulfillment.kind],
        ),
      ),
      byCommercialReadiness: countBy(
        plans.flatMap((plan) =>
          plan.humanFulfillment === null ? [] : [plan.humanFulfillment.commercialReadiness],
        ),
      ),
    },
    plans,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Execution routing: ${String(plans.length)} plan(s)`,
      `profile: ${profile.id}`,
      `evaluator: ${evaluatorId ?? "latest current evaluation per opportunity"}`,
      ...plans.map((plan, index) => {
        const human =
          plan.humanFulfillment === null
            ? ""
            : ` human=${plan.humanFulfillment.kind}/${plan.humanFulfillment.commercialReadiness}`;
        return `${String(index + 1)}. [${String(plan.score)} ${plan.decision}${human}] ${plan.opportunityId}`;
      }),
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opportunity execution routing failed: ${message}\n`);
  process.exitCode = 1;
});
