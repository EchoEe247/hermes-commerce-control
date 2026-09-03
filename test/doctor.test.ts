/**
 * Doctor contract tests.
 *
 * The doctor is what an operator runs to decide whether the Mode-A guarantees
 * actually hold on this device, so it has to be right about two opposite risks:
 *
 *  - It must FAIL when a real capability is missing or a wallet secret is
 *    present, because a green doctor is what a reviewer will trust.
 *  - It must not fail on a missing convenience (an unbuilt `dist/`, a repository
 *    root that export would create anyway), because a doctor that cries wolf
 *    trains an operator to ignore it.
 *
 * It must also never become the thing that leaks a secret: it reports
 * environment-variable NAMES and never values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  findFlaggedEnvNames,
  findWalletSecretEnvNames,
  resolvePackageRoot,
  runDoctor,
  WALLET_SECRET_ENV_FRAGMENTS,
  type DoctorReport,
} from "../src/doctor.js";

const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

/** Every check the plan requires the doctor to perform. */
const REQUIRED_CHECKS: readonly string[] = [
  "node_version",
  "node_sqlite",
  "mode_a",
  "external_writes_disabled",
  "live_value_movement_disabled",
  "wallet_secret_absent",
  "state_writable",
  "state_migrations",
  "adapters_registered",
  "repo_root",
  "build_artifact",
  "mcp_entrypoint",
];

interface Roots {
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => void;
}

function tempRoots(extra: Record<string, string> = {}): Roots {
  const root = mkdtempSync(join(tmpdir(), "hermes-doctor-test-"));
  return {
    root,
    env: {
      COMMERCE_STATE_ROOT: join(root, "state"),
      COMMERCE_REPO_ROOT: join(root, "repo"),
      ...extra,
    },
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function doctorFor(
  env: Record<string, string | undefined>,
  adapterCount = 7,
  packageRoot?: string,
): Promise<DoctorReport> {
  const config = loadConfig(env);
  return runDoctor({
    config,
    env,
    adapterCount,
    clock: CLOCK,
    ...(packageRoot === undefined ? {} : { packageRoot }),
  });
}

function byId(report: DoctorReport): Map<string, { status: string; detail: string }> {
  return new Map(report.checks.map((check) => [check.id, check]));
}

// ------------------------------------------------------------------ coverage

test("doctor: performs every check the plan requires", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env);
    const checks = byId(report);
    for (const required of REQUIRED_CHECKS) {
      assert.ok(checks.has(required), `doctor must perform check ${required}`);
    }
  } finally {
    roots.cleanup();
  }
});

test("doctor: is healthy on this runtime with Mode A and no wallet secret", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env);
    const checks = byId(report);

    assert.equal(report.ok, true, `doctor unhealthy: ${JSON.stringify(report.checks)}`);
    assert.equal(report.mode, "A");
    assert.equal(report.externalWritesEnabled, false);
    assert.equal(report.liveValueMovementEnabled, false);
    assert.equal(report.walletSecretPresent, false);

    // Runtime the plan commits to.
    assert.equal(checks.get("node_version")?.status, "pass");
    assert.equal(report.node.major, 24);
    assert.equal(checks.get("node_sqlite")?.status, "pass");

    // Policy invariants.
    assert.equal(checks.get("mode_a")?.status, "pass");
    assert.equal(checks.get("external_writes_disabled")?.status, "pass");
    assert.equal(checks.get("live_value_movement_disabled")?.status, "pass");
    assert.equal(checks.get("wallet_secret_absent")?.status, "pass");

    // Local state.
    assert.equal(checks.get("state_writable")?.status, "pass");
    assert.equal(checks.get("state_migrations")?.status, "pass");

    // Adapters.
    assert.equal(checks.get("adapters_registered")?.status, "pass");
  } finally {
    roots.cleanup();
  }
});

test("doctor: summary counts agree with the check list", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env);
    const total = report.summary.pass + report.summary.warn + report.summary.fail;
    assert.equal(total, report.checks.length);
    assert.equal(report.ok, report.summary.fail === 0);
  } finally {
    roots.cleanup();
  }
});

// ------------------------------------------------------------------- failures

test("doctor: an unwritable state root is a hard failure", async () => {
  const roots = tempRoots();
  try {
    // A regular file cannot contain a directory, so this is a portable,
    // deterministic way to make the state root genuinely unusable.
    const blocker = join(roots.root, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");

    const report = await doctorFor({
      ...roots.env,
      COMMERCE_STATE_ROOT: join(blocker, "state"),
    });
    const checks = byId(report);
    assert.equal(checks.get("state_writable")?.status, "fail");
    assert.equal(checks.get("state_migrations")?.status, "fail");
    assert.equal(report.ok, false, "an unusable state root must make the doctor unhealthy");
  } finally {
    roots.cleanup();
  }
});

test("doctor: a wallet private key is a hard failure", async () => {
  const roots = tempRoots({ PIPRAIL_PRIVATE_KEY: "0xabc123notarealkey" });
  try {
    const report = await doctorFor(roots.env);
    const checks = byId(report);
    assert.equal(checks.get("wallet_secret_absent")?.status, "fail");
    assert.equal(report.walletSecretPresent, true);
    assert.equal(report.ok, false);
    assert.deepEqual([...report.walletSecretEnvNames], ["PIPRAIL_PRIVATE_KEY"]);
  } finally {
    roots.cleanup();
  }
});

test("doctor: a mnemonic, seed phrase, NWC or signing key all fail closed", async () => {
  for (const name of [
    "WALLET_MNEMONIC",
    "MY_SEED_PHRASE",
    "NWC_URI",
    "X402_SIGNING_KEY",
    "KEYSTORE_JSON",
  ]) {
    const roots = tempRoots({ [name]: "value-shaped-secret" });
    try {
      const report = await doctorFor(roots.env);
      assert.equal(report.walletSecretPresent, true, `${name} must be detected`);
      assert.equal(report.ok, false, `${name} must make the doctor unhealthy`);
    } finally {
      roots.cleanup();
    }
  }
});

test("doctor: the report never contains a secret VALUE, only names", async () => {
  const secret = "0xdeadbeefcafebabesupersecretvalue";
  const roots = tempRoots({ PIPRAIL_PRIVATE_KEY: secret, GITHUB_TOKEN: "ghp_notarealtokenvalue" });
  try {
    const report = await doctorFor(roots.env);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secret), false, "doctor leaked a wallet secret value");
    assert.equal(
      serialized.includes("ghp_notarealtokenvalue"),
      false,
      "doctor leaked a token value",
    );
    // The NAME is legitimate diagnostic output.
    assert.ok(serialized.includes("PIPRAIL_PRIVATE_KEY"));
  } finally {
    roots.cleanup();
  }
});

test("doctor: an empty secret variable is not treated as present", async () => {
  const roots = tempRoots({ PIPRAIL_PRIVATE_KEY: "   " });
  try {
    const report = await doctorFor(roots.env);
    assert.equal(report.walletSecretPresent, false, "a blank value is not a secret");
    assert.equal(report.ok, true);
  } finally {
    roots.cleanup();
  }
});

// ------------------------------------------------------------------- warnings

test("doctor: a generic credential is a warning, not a failure", async () => {
  const roots = tempRoots({ SOME_API_KEY: "abc123" });
  try {
    const report = await doctorFor(roots.env);
    const checks = byId(report);
    // A generic token is hygiene, not spending authority.
    assert.equal(checks.get("credential_env_clean")?.status, "warn");
    assert.equal(checks.get("wallet_secret_absent")?.status, "pass");
    assert.equal(report.walletSecretPresent, false);
    assert.equal(report.ok, true);
  } finally {
    roots.cleanup();
  }
});

test("doctor: an unbuilt package warns rather than fails", async () => {
  const roots = tempRoots();
  try {
    // A package root with no dist/ at all.
    const report = await doctorFor(roots.env, 7, join(roots.root, "empty-package"));
    const checks = byId(report);
    assert.equal(checks.get("build_artifact")?.status, "warn");
    assert.equal(checks.get("mcp_entrypoint")?.status, "warn");
    assert.equal(report.ok, true, "an unbuilt package is a warning, not a broken install");
  } finally {
    roots.cleanup();
  }
});

test("doctor: a missing repository root warns because export creates it", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env);
    assert.equal(byId(report).get("repo_root")?.status, "warn");
    assert.equal(report.ok, true);
  } finally {
    roots.cleanup();
  }
});

test("doctor: a short adapter registry warns instead of failing", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env, 3);
    const check = byId(report).get("adapters_registered");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /3 of 7/);
    assert.equal(report.ok, true);
  } finally {
    roots.cleanup();
  }
});

// ------------------------------------------------------- built package checks

test("doctor: the real package root reports its compiled entrypoints", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env, 7, resolvePackageRoot());
    const checks = byId(report);
    // Never a failure either way: source can run through tsx.
    assert.notEqual(checks.get("build_artifact")?.status, "fail");
    assert.notEqual(checks.get("mcp_entrypoint")?.status, "fail");
    assert.match(checks.get("mcp_entrypoint")?.detail ?? "", /mcp[/\\]server\.js/);
  } finally {
    roots.cleanup();
  }
});

// -------------------------------------------------------------- helper units

test("doctor: the wallet fragment list covers the forbidden secret classes", () => {
  for (const fragment of ["PRIVATE_KEY", "MNEMONIC", "SEED_PHRASE", "WALLET_SECRET", "NWC"]) {
    assert.ok(
      WALLET_SECRET_ENV_FRAGMENTS.includes(fragment),
      `wallet fragment list must cover ${fragment}`,
    );
  }
});

test("doctor: wallet detection is narrower than generic credential detection", () => {
  const env = { SOME_API_KEY: "x", WALLET_PRIVATE_KEY: "y" };
  assert.deepEqual(findWalletSecretEnvNames(env), ["WALLET_PRIVATE_KEY"]);
  assert.deepEqual(findFlaggedEnvNames(env), ["SOME_API_KEY", "WALLET_PRIVATE_KEY"]);
});

test("doctor: the report is JSON round-trippable for receipts", async () => {
  const roots = tempRoots();
  try {
    const report = await doctorFor(roots.env);
    const parsed = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assert.equal(parsed.mode, "A");
    assert.equal(parsed.checkedAt, "2026-08-19T00:00:00.000Z");
    assert.ok(Array.isArray(parsed.checks));
  } finally {
    roots.cleanup();
  }
});
