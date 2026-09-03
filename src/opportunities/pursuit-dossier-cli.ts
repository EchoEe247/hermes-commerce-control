#!/usr/bin/env node
/** Offline pursuit dossiers. No network/model/external mutation. */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { JsonlOpportunityEvaluationResultStore } from "./evaluation-results.js";
import {
  OPERATOR_PACKET_ACTIONS,
  prepareOpportunityOperatorPackets,
  type OperatorPacketAction,
} from "./operator-packet.js";
import { OPPORTUNITY_PROFILE_IDS, resolveOpportunityProfile } from "./profiles.js";
import { buildOpportunityPursuitDossiers } from "./pursuit-dossier.js";
import { DEFAULT_RANKING_MAX_AGE_HOURS, rankStoredOpportunities } from "./ranking.js";
import { JsonlOpportunityStore } from "./store.js";

const HELP = `Prepare pursuit dossiers offline

Usage:
  node --import tsx src/opportunities/pursuit-dossier-cli.ts [options]

Options:
      --profile <name>          ${OPPORTUNITY_PROFILE_IDS.join(" | ")} (default: demand)
      --evaluator <id>          only use evaluations from this exact evaluator ID
      --action <name>           review_for_pursuit | manual_review (repeatable)
      --min-score <0-100>       minimum deterministic rank score (default: 0)
      --max-age-hours <n>       listing/evaluation age window (default: ${String(DEFAULT_RANKING_MAX_AGE_HOURS)}; 0 disables)
      --as-of <timestamp>       deterministic ranking clock for replay/tests
      --limit <n>               max dossiers (default: 25)
      --scan-limit <n>          max persisted opportunities to inspect (default: 1000)
      --state-file <path>       opportunity JSONL store
      --evaluation-file <path>  evaluation-result JSONL store
      --json                    emit one JSON document
      --help

This command only prepares internal pursuit dossiers. It does not fetch Reddit,
call a model, contact anyone, claim/accept work, submit work, hire, or move money.
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
  if (!Number.isFinite(value) || value < 0 || value > 24 * 365) {
    throw new Error("--max-age-hours must be a number from 0 to 8760");
  }
  return value;
}

function actions(raw: readonly string[] | undefined): readonly OperatorPacketAction[] {
  if (raw === undefined || raw.length === 0) return OPERATOR_PACKET_ACTIONS;
  const out: OperatorPacketAction[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (!(OPERATOR_PACKET_ACTIONS as readonly string[]).includes(normalized)) {
      throw new Error(`invalid --action ${JSON.stringify(value)}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized as OperatorPacketAction);
  }
  return Object.freeze(out);
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.freeze(counts);
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
  const ageHours = maxAgeHours(values["max-age-hours"]);
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
      maxAgeHours: ageHours,
      ...(values["as-of"] === undefined ? {} : { asOf: values["as-of"] }),
      limit,
      scanLimit,
    },
  );
  const operatorPackets = prepareOpportunityOperatorPackets(ranked, limit);
  const dossiers = buildOpportunityPursuitDossiers(operatorPackets, limit);
  const output = {
    ok: true,
    mode: "offline-pursuit-dossier",
    profile: profile.id,
    evaluatorId: evaluatorId ?? null,
    actions: selectedActions,
    minimumScore,
    maxAgeHours: ageHours,
    stateFile,
    evaluationFile,
    dossierCount: dossiers.length,
    counts: {
      byStatus: countBy(dossiers.map((dossier) => dossier.status)),
      byOperatorAction: countBy(dossiers.map((dossier) => dossier.ranking.operatorAction)),
      byExecutionRoute: countBy(dossiers.map((dossier) => dossier.ranking.executionRoute)),
      byContactBriefStatus: countBy(dossiers.map((dossier) => dossier.contactBrief.status)),
    },
    dossiers,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Pursuit dossiers: ${String(dossiers.length)}`,
      `profile: ${profile.id}`,
      `evaluator: ${evaluatorId ?? "latest current evaluation"}`,
      ...dossiers.map(
        (dossier, index) =>
          `${String(index + 1)}. [${String(dossier.ranking.score)} ${dossier.status}/${dossier.ranking.executionRoute}] ${dossier.opportunity.title}`,
      ),
    ].join("\n") + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pursuit dossier preparation failed: ${message}\n`);
  process.exitCode = 1;
});
