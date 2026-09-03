#!/usr/bin/env node
/** Append one local verification-resolution record. No network/model/external action. */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import {
  buildOpportunityVerificationResolution,
  JsonlOpportunityVerificationResolutionStore,
  VERIFICATION_EVIDENCE_KINDS,
  VERIFICATION_RESOLUTION_OUTCOMES,
  type VerificationEvidenceKind,
  type VerificationResolutionOutcome,
} from "./verification-resolutions.js";

const HELP = `Record one local opportunity-verification result

Usage:
  node --import tsx src/opportunities/record-verification-cli.ts [options]

Required:
      --dossier-id <id>                 current opdos_* ID
      --check-id <id>                   current opcheck_* ID
      --outcome <name>                  satisfied | failed
      --evidence-kind <name>            ${VERIFICATION_EVIDENCE_KINDS.join(" | ")}
      --note <text>                      bounded evidence note

Optional:
      --reference <text>                source/quote/confirmation reference; required for
                                        source_reference, executor_quote, counterparty_confirmation
      --depends-on-resolution-id <id>   prerequisite opver_* used by a derived calculation
                                        (repeat once per current dependency)
      --recorded-at <timestamp>         deterministic timestamp override
      --resolution-file <path>          verification-resolution JSONL store
      --json                            emit one JSON document
      --help

Derived calculations must bind to the exact current prerequisite resolution IDs exposed
by opportunities:verification-plan. The plan rejects a calculation recorded before its
prerequisites or tied to stale prerequisite resolutions.

This command only appends local evidence. It does not contact anyone, fetch a source,
call a model, approve pursuit, claim work, submit, hire, or move money.
`;

type ParsedValue = string | boolean | string[] | undefined;

function required(values: Record<string, ParsedValue>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value.trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      "dossier-id": { type: "string" },
      "check-id": { type: "string" },
      outcome: { type: "string" },
      "evidence-kind": { type: "string" },
      note: { type: "string" },
      reference: { type: "string" },
      "depends-on-resolution-id": { type: "string", multiple: true },
      "recorded-at": { type: "string" },
      "resolution-file": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const dossierId = required(values, "dossier-id");
  const checkId = required(values, "check-id");
  const outcomeRaw = required(values, "outcome").toLowerCase();
  const evidenceKindRaw = required(values, "evidence-kind").toLowerCase();
  const note = required(values, "note");
  if (!(VERIFICATION_RESOLUTION_OUTCOMES as readonly string[]).includes(outcomeRaw)) {
    throw new Error(`invalid --outcome ${JSON.stringify(outcomeRaw)}`);
  }
  if (!(VERIFICATION_EVIDENCE_KINDS as readonly string[]).includes(evidenceKindRaw)) {
    throw new Error(`invalid --evidence-kind ${JSON.stringify(evidenceKindRaw)}`);
  }

  const config = loadConfig(process.env);
  const resolutionFile = resolve(
    typeof values["resolution-file"] === "string"
      ? values["resolution-file"]
      : join(config.stateRoot, "opportunity-verifications.jsonl"),
  );
  const reference = typeof values.reference === "string" && values.reference.trim() !== ""
    ? values.reference.trim()
    : undefined;
  const recordedAt = typeof values["recorded-at"] === "string" && values["recorded-at"].trim() !== ""
    ? values["recorded-at"].trim()
    : undefined;
  const dependsOnResolutionIds = Array.isArray(values["depends-on-resolution-id"])
    ? values["depends-on-resolution-id"].map((value) => value.trim()).filter((value) => value !== "")
    : undefined;

  const record = buildOpportunityVerificationResolution({
    dossierId,
    checkId,
    outcome: outcomeRaw as VerificationResolutionOutcome,
    evidence: {
      kind: evidenceKindRaw as VerificationEvidenceKind,
      ...(reference === undefined ? {} : { reference }),
      note,
    },
    ...(dependsOnResolutionIds === undefined || dependsOnResolutionIds.length === 0
      ? {}
      : { dependsOnResolutionIds }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
  });
  await new JsonlOpportunityVerificationResolutionStore(resolutionFile).append(record);

  const output = {
    ok: true,
    mode: "local-verification-record",
    resolutionFile,
    record,
    externalActionsAllowed: false,
  };
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  process.stdout.write(`Recorded ${record.resolutionId} for ${record.checkId} (${record.outcome})\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`verification resolution recording failed: ${message}\n`);
  process.exitCode = 1;
});
