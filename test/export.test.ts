import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase, closeStateDatabase } from "../src/state/sqlite.js";
import { runMigrations } from "../src/state/migrations.js";
import { CommerceRepository } from "../src/state/repository.js";
import { EXPORT_PATHS, exportRepositoryOutputs, sanitizeForExport, writeArtifact } from "../src/export/repo.js";
import { loadConfig } from "../src/config.js";

function tempContext(): {
  dir: string;
  repoRoot: string;
  stateRoot: string;
  repo: CommerceRepository;
  cleanup: () => void;
  config: ReturnType<typeof loadConfig>;
} {
  const dir = mkdtempSync(join(tmpdir(), "hcc-export-test-"));
  const repoRoot = join(dir, "repo");
  const stateRoot = join(dir, "state");
  const dbPath = join(stateRoot, "commerce.db");

  const db = openStateDatabase(dbPath);
  runMigrations(db);
  const repo = new CommerceRepository(db);

  const env = {
    COMMERCE_STATE_ROOT: stateRoot,
    COMMERCE_REPO_ROOT: repoRoot,
  };
  const config = loadConfig(env);

  return {
    dir,
    repoRoot,
    stateRoot,
    repo,
    config,
    cleanup: (): void => {
      closeStateDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("export: writes only to the explicit non-authoritative legacy snapshot namespace", () => {
  const ctx = tempContext();
  try {
    const exportedAt = "2026-08-19T00:00:00.000Z";
    const artifacts = exportRepositoryOutputs({
      config: ctx.config,
      repo: ctx.repo,
      exportedAt,
    });

    assert.equal(artifacts.length, 4);

    const expectedPaths = [
      "analytics/commerce-control/legacy/services-snapshot.json",
      "analytics/commerce-control/legacy/work-snapshot.json",
      "analytics/commerce-control/legacy/source-health-snapshot.json",
      "analytics/commerce-control/legacy/status-snapshot.json",
    ];
    assert.deepEqual(Object.values(EXPORT_PATHS), expectedPaths);

    for (const p of expectedPaths) {
      assert.equal(p.startsWith("state/"), false);
      assert.doesNotMatch(p, /latest\.json$/i);
      const fullPath = join(ctx.repoRoot, p);
      assert.ok(existsSync(fullPath), `Export path ${p} should exist`);
      const content = readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(content);
      assert.equal(parsed.authority, false);
      assert.equal(parsed.mode, "A");
      assert.equal(parsed.generatedAt ?? parsed.checkedAt ?? exportedAt, exportedAt);
    }
  } finally {
    ctx.cleanup();
  }
});

test("export: refuses authoritative-looking state and latest paths", () => {
  const ctx = tempContext();
  try {
    for (const path of [
      "state/commerce-control/STATUS.json",
      "analytics/commerce-control/status-latest.json",
      "analytics/commerce-control/source-health-latest.json",
    ]) {
      assert.throws(
        () => writeArtifact(ctx.repoRoot, path, "bad", {}, "2026-08-19T00:00:00.000Z"),
        /authoritative-looking legacy export path/i,
      );
    }
  } finally {
    ctx.cleanup();
  }
});

test("export: robustly scrubs and redacts secret-like values during export", () => {
  const secretKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyPayload.signature";
  const privateKeyEnvLine = "PRIVATE_KEY=secret_value";

  const payload = {
    nested: {
      secret_key: secretKey,
      token: bearerToken,
      safe_field: "this is completely safe text",
      config_line: privateKeyEnvLine,
    },
    digest: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    other_hex: "1111111111111111111111111111111111111111111111111111111111111111",
  };

  const sanitized = sanitizeForExport(payload) as Record<string, any>;

  assert.notEqual(sanitized.nested.secret_key, secretKey);
  assert.ok(sanitized.nested.secret_key.includes("REDACTED"));
  assert.notEqual(sanitized.nested.token, bearerToken);
  assert.ok(sanitized.nested.token.includes("REDACTED"));
  assert.notEqual(sanitized.nested.config_line, privateKeyEnvLine);
  assert.ok(sanitized.nested.config_line.includes("REDACTED"));

  assert.equal(sanitized.digest, "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.notEqual(sanitized.other_hex, "1111111111111111111111111111111111111111111111111111111111111111");
  assert.ok(sanitized.other_hex.includes("REDACTED"));
});

test("export: operation receipt records correct Mode-A booleans and false execution flags", () => {
  const ctx = tempContext();
  try {
    const startedAt = "2026-08-19T01:00:00.000Z";
    const endedAt = "2026-08-19T01:01:00.000Z";

    ctx.repo.saveOperation({
      id: "op_test_12345678",
      type: "discover_services",
      startedAt,
      endedAt,
      mode: "A",
      sourcesRequested: 7,
      sourcesSucceeded: 6,
      sourcesFailed: 1,
      resultCount: 42,
      financialActionExecuted: false,
      externalMutationExecuted: false,
      evidencePaths: [EXPORT_PATHS.services],
      errors: ["the402:unreachable"],
    });

    const record = ctx.repo.getOperation("op_test_12345678");
    assert.ok(record);
    assert.equal(record.type, "discover_services");
    assert.equal(record.mode, "A");
    assert.equal(record.financialActionExecuted, false);
    assert.equal(record.externalMutationExecuted, false);
    assert.equal(record.resultCount, 42);
    assert.deepEqual([...(record.evidencePaths ?? [])], [EXPORT_PATHS.services]);
    assert.deepEqual([...(record.errors ?? [])], ["the402:unreachable"]);
  } finally {
    ctx.cleanup();
  }
});
