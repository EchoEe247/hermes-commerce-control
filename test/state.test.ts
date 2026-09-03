import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase, closeStateDatabase } from "../src/state/sqlite.js";
import { runMigrations, currentSchemaVersion, MIGRATIONS } from "../src/state/migrations.js";
import { CommerceRepository } from "../src/state/repository.js";
import { modeAServiceActionability, modeAWorkActionability } from "../src/core/models.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "hcc-state-"));
  return { dir, path: join(dir, "state.db") };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("state: migrations create every declared table", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const expected of [
      "schema_migrations",
      "sources",
      "services",
      "service_observations",
      "work_items",
      "work_observations",
      "quotes",
      "intents",
      "policy_decisions",
      "probes",
      "evidence",
      "exports",
      "operations",
    ]) {
      assert.ok(names.has(expected), `missing table ${expected}`);
    }
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: running migrations twice is idempotent", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    const first = runMigrations(db);
    const second = runMigrations(db);
    assert.equal(first.appliedTo, currentSchemaVersion());
    assert.equal(second.appliedTo, currentSchemaVersion());
    assert.equal(second.applied.length, 0, "second run should apply nothing");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    assert.equal(count.n, MIGRATIONS.length);
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: probe survives close and reopen", () => {
  const { dir, path } = tempDb();
  try {
    const db1 = openStateDatabase(path);
    runMigrations(db1);
    const repo1 = new CommerceRepository(db1);
    repo1.saveProbe({
      platform: "cdp_bazaar",
      status: "ok",
      checkedAt: "2026-08-19T00:00:00.000Z",
      latencyMs: 120,
      detail: "public discovery reachable",
    });
    closeStateDatabase(db1);

    const db2 = openStateDatabase(path);
    runMigrations(db2);
    const repo2 = new CommerceRepository(db2);
    const probes = repo2.listProbes("cdp_bazaar");
    assert.equal(probes.length, 1);
    assert.equal(probes[0]?.status, "ok");
    assert.equal(probes[0]?.latencyMs, 120);
    closeStateDatabase(db2);
  } finally {
    cleanup(dir);
  }
});

test("state: services upsert by canonical id and accumulate observations", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const repo = new CommerceRepository(db);

    const service = {
      id: "svc_00000000000000000000000000000001",
      kind: "service" as const,
      sources: [
        {
          source: "cdp_bazaar" as const,
          externalId: "res-1",
          observedAt: "2026-08-19T00:00:00.000Z",
        },
      ],
      name: "Profiler",
      resourceUrl: "https://api.example.com/v1/profile",
      method: "POST",
      protocol: "x402",
      network: "eip155:84532",
      health: "ok" as const,
      observedAt: "2026-08-19T00:00:00.000Z",
      tags: [],
      evidence: [],
      actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
    };

    repo.saveService(service);
    repo.saveService({
      ...service,
      sources: [
        { source: "agent402" as const, externalId: "a402-9", observedAt: "2026-08-19T01:00:00.000Z" },
      ],
    });

    const stored = repo.getService(service.id);
    assert.ok(stored);
    assert.equal(stored?.name, "Profiler");
    const obs = repo.listServiceObservations(service.id);
    assert.equal(obs.length, 2, "both source observations should persist");
    const sources = new Set(obs.map((o) => o.source));
    assert.deepEqual([...sources].sort(), ["agent402", "cdp_bazaar"]);
    // One canonical service row, not two.
    const n = db.prepare("SELECT COUNT(*) AS n FROM services").get() as { n: number };
    assert.equal(n.n, 1);
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: work items persist funding and verification classification", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const repo = new CommerceRepository(db);
    repo.saveWork({
      id: "wrk_00000000000000000000000000000001",
      kind: "work",
      source: "agent_bounties",
      externalId: "42",
      title: "Fix a bug",
      reward: { amount: "5", asset: "USDC", network: "eip155:8453" },
      funding: { state: "funded", evidence: "observed" },
      verification: { type: "deterministic" },
      status: "open",
      requirements: ["tests must pass"],
      observedAt: "2026-08-19T00:00:00.000Z",
      evidence: [],
      actionability: modeAWorkActionability({ canPrepareClaim: true }),
    });
    const stored = repo.getWork("wrk_00000000000000000000000000000001");
    assert.equal(stored?.funding.state, "funded");
    assert.equal(stored?.funding.evidence, "observed");
    assert.equal(stored?.verification.type, "deterministic");
    assert.equal(stored?.actionability.canClaim, false);
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: operations are recorded once and receipts are not duplicated", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const repo = new CommerceRepository(db);
    const op = {
      id: "op_abc",
      type: "discover_services",
      startedAt: "2026-08-19T00:00:00.000Z",
      endedAt: "2026-08-19T00:00:01.000Z",
      mode: "A" as const,
      financialActionExecuted: false,
      externalMutationExecuted: false,
      sourcesRequested: 3,
      sourcesSucceeded: 2,
      sourcesFailed: 1,
      resultCount: 7,
    };
    repo.saveOperation(op);
    // Replaying the same operation id must not create a second row.
    repo.saveOperation(op);
    const n = db.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number };
    assert.equal(n.n, 1);
    const stored = repo.getOperation("op_abc");
    assert.equal(stored?.financialActionExecuted, false);
    assert.equal(stored?.resultCount, 7);
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: policy decisions and intents persist with their block reason", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const repo = new CommerceRepository(db);
    repo.savePolicyDecision({
      decision: "block",
      rule: "A_MODE_VALUE_MOVEMENT",
      operation: "prepare_purchase",
      class: "VALUE_MOVEMENT",
      mode: "A",
      reason: "LIVE_VALUE_MOVEMENT_DISABLED",
      requiredActivation: "B2",
      evaluatedAt: "2026-08-19T00:00:00.000Z",
      detail: "blocked",
    });
    repo.saveIntent({
      id: "int_payment_abc",
      kind: "payment",
      platform: "cdp_bazaar",
      targetId: "svc_1",
      createdAt: "2026-08-19T00:00:00.000Z",
      hash: "a".repeat(64),
      body: { amount: "0.02" },
      decisionRule: "A_MODE_VALUE_MOVEMENT",
      decisionOutcome: "block",
      financialActionExecuted: false,
      externalMutationExecuted: false,
    });
    const intents = repo.listIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.decisionOutcome, "block");
    assert.equal(intents[0]?.financialActionExecuted, false);
    const decisions = db
      .prepare("SELECT reason FROM policy_decisions")
      .all() as Array<{ reason: string }>;
    assert.equal(decisions[0]?.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: foreign keys are enforced", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, number>;
    assert.equal(Object.values(fk)[0], 1, "foreign_keys pragma should be on");
    // An observation for a nonexistent service must be rejected.
    assert.throws(() => {
      db.prepare(
        "INSERT INTO service_observations (service_id, source, external_id, observed_at) VALUES (?, ?, ?, ?)",
      ).run("svc_does_not_exist", "cdp_bazaar", "x", "2026-08-19T00:00:00.000Z");
    });
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: extension loading is never enabled", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    // node:sqlite exposes enableLoadExtension; our opener must not have turned
    // it on. Attempting to load an extension must fail.
    assert.throws(() => {
      db.prepare("SELECT load_extension('evil')").get();
    });
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("state: evidence rows never store an authorization header", () => {
  const { dir, path } = tempDb();
  try {
    const db = openStateDatabase(path);
    runMigrations(db);
    const repo = new CommerceRepository(db);
    repo.saveEvidence({
      platform: "cdp_bazaar",
      fact: "price",
      value: "0.02",
      classification: "observed",
      sourceType: "http_api",
      sourceRef: "https://api.example.com/x",
      capturedAt: "2026-08-19T00:00:00.000Z",
      hash: "b".repeat(64),
    });
    const rows = db.prepare("SELECT * FROM evidence").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const serialized = JSON.stringify(rows).toLowerCase();
    assert.equal(serialized.includes("authorization"), false);
    assert.equal(serialized.includes("bearer "), false);
    closeStateDatabase(db);
  } finally {
    cleanup(dir);
  }
});
