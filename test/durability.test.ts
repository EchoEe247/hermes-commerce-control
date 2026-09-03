import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalOpportunityId, type OpportunityCandidate } from "../src/opportunities/models.js";
import { JsonlOpportunityStore } from "../src/opportunities/store.js";
import { buildOpportunityEvaluationPacket } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import { JsonlOpportunityEvaluationResultStore } from "../src/opportunities/evaluation-results.js";
import { runPreparedOpportunityEvaluations } from "../src/opportunities/evaluation-runner.js";
import { triageOpportunity } from "../src/opportunities/triage.js";
import {
  buildOpportunityVerificationResolution,
  JsonlOpportunityVerificationResolutionStore,
} from "../src/opportunities/verification-resolutions.js";
import { openStateDatabase, closeStateDatabase } from "../src/state/sqlite.js";
import { runMigrations } from "../src/state/migrations.js";
import { CommerceRepository } from "../src/state/repository.js";

const NOW = "2026-08-29T07:00:00.000Z";

function candidate(externalId: string): OpportunityCandidate {
  const url = `https://www.reddit.com/r/forhire/comments/${externalId}/job/`;
  return {
    id: canonicalOpportunityId({ source: "reddit_rss", externalId, url }),
    source: "reddit_rss",
    externalId,
    title: `[HIRING] Remote automation ${externalId}`,
    body: "Budget $150. Remote API automation.",
    url,
    observedAt: NOW,
    tags: ["reddit", "automation"],
    metadata: {},
  };
}

const validEvaluation = {
  schemaVersion: 1,
  recommendation: "pursue",
  executionRoute: "ai_direct",
  risk: "low",
  confidence: 0.9,
  estimatedEffortMinutes: 60,
  economics: {
    payout: { minUsd: 150, maxUsd: null, basis: "observed" },
    executionCost: { minUsd: 0, maxUsd: 10, basis: "inferred" },
    margin: { minUsd: 140, maxUsd: 150, basis: "inferred" },
  },
  capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
  reasons: ["remote automation work with explicit budget"],
  blockers: [],
  nextChecks: ["verify current participation rules"],
};

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("opportunity JSONL store serializes concurrent read-dedupe-append across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-durable-opportunities-"));
  try {
    const path = join(root, "opportunities.jsonl");
    const storeA = new JsonlOpportunityStore(path);
    const storeB = new JsonlOpportunityStore(path);
    const one = candidate("batch7-one");
    const two = candidate("batch7-two");

    const counts = await Promise.all([
      storeA.saveMany([one, two]),
      storeB.saveMany([one]),
    ]);
    assert.equal(counts.reduce((sum, value) => sum + value, 0), 2);

    const rows = await storeA.list();
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation runner acquires one durable claim before concurrent model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-durable-evaluation-"));
  try {
    const path = join(root, "evaluations.jsonl");
    const storeA = new JsonlOpportunityEvaluationResultStore(path);
    const storeB = new JsonlOpportunityEvaluationResultStore(path);
    const opportunity = candidate("batch7-eval");
    const triage = triageOpportunity(opportunity, { requireDemand: true });
    const prepared = buildPreparedOpportunityEvaluation(
      buildOpportunityEvaluationPacket(opportunity, triage),
    );
    let calls = 0;
    const evaluator = {
      id: "batch7-evaluator",
      async evaluate() {
        calls += 1;
        await sleep(100);
        return validEvaluation;
      },
    };

    const [runA, runB] = await Promise.all([
      runPreparedOpportunityEvaluations([prepared], evaluator, storeA, { clock: () => NOW }),
      runPreparedOpportunityEvaluations([prepared], evaluator, storeB, { clock: () => NOW }),
    ]);

    assert.equal(calls, 1, "only the worker holding the durable claim may call the evaluator");
    const statuses = [runA[0]?.status, runB[0]?.status].sort();
    assert.deepEqual(statuses, ["completed", "skipped"]);
    const skipped = [runA[0], runB[0]].find((entry) => entry?.status === "skipped");
    assert.ok(skipped?.status === "skipped");
    assert.ok(skipped.reason === "claimed_elsewhere" || skipped.reason === "already_evaluated");
    assert.equal((await storeA.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification resolution store suppresses duplicate concurrent append", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-durable-resolution-"));
  try {
    const path = join(root, "resolutions.jsonl");
    const storeA = new JsonlOpportunityVerificationResolutionStore(path);
    const storeB = new JsonlOpportunityVerificationResolutionStore(path);
    const record = buildOpportunityVerificationResolution({
      dossierId: `opdos_${"a".repeat(32)}`,
      checkId: `opcheck_${"b".repeat(32)}`,
      outcome: "satisfied",
      evidence: { kind: "operator_attestation", note: "bounded verification complete" },
      recordedAt: NOW,
    });

    await Promise.all([storeA.append(record), storeB.append(record)]);
    const rows = await storeA.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.resolutionId, record.resolutionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommerceRepository sanitizes untrusted text before SQLite persistence", () => {
  const db = openStateDatabase(":memory:");
  try {
    runMigrations(db);
    const repo = new CommerceRepository(db);
    const bearer = "Bearer abcdefghijklmnop12345678";
    const providerKey = "sk_live_BATCH7SUPERSECRET";

    repo.saveProbe({
      platform: "agent402",
      status: "degraded",
      checkedAt: NOW,
      detail: `upstream returned ${bearer}`,
      errorCode: providerKey,
    });
    repo.saveIntent({
      id: "intent_batch7_sanitize",
      kind: "test",
      platform: "agent402",
      targetId: "target",
      createdAt: NOW,
      hash: "batch7-safe-hash",
      body: { note: `credential ${bearer}`, token: providerKey },
      decisionRule: "test rule",
      decisionOutcome: "blocked",
      financialActionExecuted: false,
      externalMutationExecuted: false,
    });

    const probe = db.prepare("SELECT detail, error_code FROM probes LIMIT 1").get() as {
      detail: string;
      error_code: string;
    };
    const intent = db.prepare("SELECT body FROM intents WHERE id = ?").get("intent_batch7_sanitize") as {
      body: string;
    };
    const rawSqliteText = `${probe.detail}\n${probe.error_code}\n${intent.body}`;
    assert.doesNotMatch(rawSqliteText, /abcdefghijklmnop12345678/);
    assert.doesNotMatch(rawSqliteText, /BATCH7SUPERSECRET/);
    assert.match(rawSqliteText, /\[REDACTED\]/);

    const body = JSON.parse(intent.body) as { note: string; token: string };
    assert.equal(body.token, "[REDACTED]");
    assert.match(body.note, /\[REDACTED\]/);
  } finally {
    closeStateDatabase(db);
  }
});
