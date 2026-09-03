import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProfilerManifest,
  inspectProfiler,
  PRODUCT_RELATIVE_PATH,
} from "../src/products/data-quality-profiler.js";
import { loadConfig } from "../src/config.js";
import { preparePublish } from "../src/actions/publish.js";
import { createProfilerRepositoryFixture } from "./fixtures/profiler-repo.js";

/** Self-contained repository-shaped fixture; never depend on a parent monorepo. */
const REPO_ROOT = mkdtempSync(join(tmpdir(), "hcc-profiler-repo-"));
createProfilerRepositoryFixture(REPO_ROOT);
after(() => rmSync(REPO_ROOT, { recursive: true, force: true }));

test("profiler: derives version, routes, price and network from the product tree", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.present, true, `product not found under ${REPO_ROOT}`);
  assert.equal(readiness.product, "data-quality-profiler");
  assert.equal(readiness.path, PRODUCT_RELATIVE_PATH);
  assert.equal(readiness.version, "0.1.0");
  assert.equal(readiness.routes.health, true);
  assert.equal(readiness.routes.profile, true);
  assert.equal(readiness.x402.price, "$0.02");
  assert.equal(readiness.x402.network, "eip155:84532");
  assert.equal(readiness.x402.version, 2);
  assert.equal(readiness.buildReady, true);
});

test("profiler: confirms mainnet is NOT permitted by the product config", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.x402.mainnetPermitted, false, "the product must allowlist Base Sepolia only");
  assert.equal(readiness.limitations.some((l) => l.includes("mainnet")), false);
});

test("profiler: derives Bazaar metadata status including official validation", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.bazaar.metadataDeclared, true);
  assert.equal(
    readiness.bazaar.metadataValidatedByTest,
    true,
    "a test should call the official validateDiscoveryExtension helper",
  );
});

test("profiler: derives the test inventory and newest verification receipt", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.tests.declared, true);
  assert.ok(readiness.tests.fileCount >= 10, `expected several test files, got ${String(readiness.tests.fileCount)}`);
  assert.ok(readiness.tests.lastVerification !== null, "a verification receipt should exist");
  assert.equal(readiness.tests.lastVerificationPassed, true);
  assert.equal(readiness.readme, true);
});

test("profiler: publication is never allowed or executed regardless of readiness", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.publicationAllowed, false);
  assert.equal(readiness.publicationExecuted, false);
  assert.equal(readiness.publishIntentReady, true);
});

test("profiler: CDP target is prepared but notes the settlement prerequisite", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  const cdp = readiness.targets.cdp_bazaar;
  assert.equal(cdp?.prepared, true);
  assert.match(String(cdp?.note), /settlement/i);
  assert.match(String(cdp?.note), /Stage B2/);
});

test("profiler: Pay.sh target is Phase-2 blocked", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  const paysh = readiness.targets.paysh;
  assert.equal(paysh?.prepared, false);
  assert.equal(paysh?.ready, false);
  assert.equal(paysh?.reason, "SOLANA_DISTRIBUTION_PHASE_2");
});

test("profiler: Agent402 target prepares metadata only", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  const a402 = readiness.targets.agent402;
  assert.equal(a402?.prepared, true);
  assert.match(String(a402?.note), /metadata only/i);
});

test("profiler: the manifest states the product is not deployed", () => {
  const manifest = buildProfilerManifest(inspectProfiler({ repoRoot: REPO_ROOT }));
  assert.equal(manifest.hostDeployed, false);
  assert.equal(manifest.network, "eip155:84532");
  assert.equal(manifest.price, "$0.02");
  assert.equal(manifest.method, "POST");
  assert.match(String(manifest.resourceUrl), /REPLACE_WITH_DEPLOYED_HOST/);
});

test("profiler: a publish intent from the manifest is blocked", () => {
  const cfg = loadConfig({});
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  const intent = preparePublish(
    cfg,
    readiness.product,
    {
      platform: "cdp_bazaar",
      product: readiness.product,
      version: readiness.version ?? "0.1.0",
      manifest: buildProfilerManifest(readiness),
      targetReady: readiness.targets.cdp_bazaar?.ready ?? false,
    },
    () => "2026-08-19T00:00:00.000Z",
  );
  assert.equal(intent.decision.decision, "block");
  assert.equal(intent.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(intent.publicationPerformed, false);
  assert.equal(intent.registrationPerformed, false);
});

test("profiler: readiness is deterministic across repeated inspection", () => {
  const a = inspectProfiler({ repoRoot: REPO_ROOT });
  const b = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(a.manifestHash, b.manifestHash);
  assert.deepEqual(a.targets, b.targets);
});

test("profiler: an absent product tree degrades instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hcc-noprod-"));
  try {
    const readiness = inspectProfiler({ repoRoot: dir });
    assert.equal(readiness.present, false);
    assert.equal(readiness.buildReady, false);
    assert.equal(readiness.publishIntentReady, false);
    assert.equal(readiness.publicationAllowed, false);
    assert.ok(readiness.limitations.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profiler: a product permitting mainnet is flagged as a limitation", () => {
  const dir = mkdtempSync(join(tmpdir(), "hcc-mainnet-"));
  try {
    const root = join(dir, PRODUCT_RELATIVE_PATH);
    mkdirSync(join(root, "src", "payments"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "9.9.9", scripts: { test: "node --test" } }),
    );
    writeFileSync(
      join(root, "src", "app.mjs"),
      'app.get("/health", async () => ({}));\napp.post("/v1/profile", async () => ({}));\n',
    );
    writeFileSync(
      join(root, "src", "config.mjs"),
      'const ALLOWED_NETWORKS = new Set(["eip155:84532", "eip155:8453"]);\n' +
        'const x402Network = env.X402_NETWORK ?? "eip155:8453";\n' +
        'x402Price: env.X402_PRICE ?? "$1.00",\n',
    );
    writeFileSync(join(root, "src", "payments", "x402-plugin.mjs"), "// no bazaar metadata\n");

    const readiness = inspectProfiler({ repoRoot: dir });
    assert.equal(readiness.version, "9.9.9", "version must be derived, not assumed");
    assert.equal(readiness.x402.price, "$1.00", "price must be derived, not assumed");
    assert.equal(readiness.x402.network, "eip155:8453");
    assert.equal(readiness.x402.mainnetPermitted, true);
    assert.ok(
      readiness.limitations.some((l) => l.includes("mainnet")),
      "permitting mainnet must be recorded as a limitation",
    );
    assert.equal(readiness.bazaar.metadataDeclared, false);
    assert.equal(readiness.targets.cdp_bazaar?.prepared, false);
    assert.equal(readiness.publishIntentReady, false);
    assert.equal(readiness.publicationAllowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profiler: inspection performs no network or process activity", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/products/data-quality-profiler.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "child_process", "execSync", "spawn", "listen("]) {
    assert.equal(source.includes(forbidden), false, `readiness inspection must not use ${forbidden}`);
  }
});

test("profiler: readiness follows the canonical published lifecycle path", () => {
  const readiness = inspectProfiler({ repoRoot: REPO_ROOT });
  assert.equal(readiness.path, "products/published/data-quality-profiler");
  assert.equal(readiness.path.startsWith("products/drafts/"), false);
});
