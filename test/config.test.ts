import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, SECRET_ENV_DENYLIST } from "../src/config.js";

const APPROVED_INTENT = "hintent_0123456789abcdef0123456789abcdef";

test("config: defaults to Mode A with all external/value gates false", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.mode, "A");
  assert.equal(cfg.externalWritesEnabled, false);
  assert.equal(cfg.liveValueMovementEnabled, false);
  assert.equal(cfg.humanRecruitmentActivation.enabled, false);
  assert.equal(cfg.humanRecruitmentActivation.approvedIntentId, null);
});

test("config: general external-write and value-movement gates still fail closed", () => {
  assert.throws(() => loadConfig({ EXTERNAL_WRITES_ENABLED: "true" }), /General external writes/);
  assert.throws(() => loadConfig({ LIVE_VALUE_MOVEMENT_ENABLED: "true" }), /Mode A/);
  for (const v of ["TRUE", "True", "1", "yes", "YES", "on", "enabled"]) {
    assert.throws(
      () => loadConfig({ EXTERNAL_WRITES_ENABLED: v }),
      /external writes/i,
      `expected rejection for EXTERNAL_WRITES_ENABLED=${v}`,
    );
    assert.throws(
      () => loadConfig({ LIVE_VALUE_MOVEMENT_ENABLED: v }),
      /Mode A/,
      `expected rejection for LIVE_VALUE_MOVEMENT_ENABLED=${v}`,
    );
  }
});

test("config: exact-intent human recruitment activation requires both gate and valid intent id", () => {
  assert.throws(
    () => loadConfig({ HUMAN_RECRUITMENT_B1_ENABLED: "true" }),
    /requires HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID/,
  );
  assert.throws(
    () => loadConfig({ HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: APPROVED_INTENT }),
    /disabled/,
  );
  assert.throws(
    () =>
      loadConfig({
        HUMAN_RECRUITMENT_B1_ENABLED: "true",
        HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: "not-an-intent",
      }),
    /hintent_/,
  );

  const cfg = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: APPROVED_INTENT,
  });
  assert.equal(cfg.humanRecruitmentActivation.enabled, true);
  assert.equal(cfg.humanRecruitmentActivation.approvedIntentId, APPROVED_INTENT);
  assert.equal(cfg.externalWritesEnabled, false, "general external writes must remain disabled");
  assert.equal(cfg.liveValueMovementEnabled, false);
});

test("config: explicitly false gates are accepted", () => {
  const cfg = loadConfig({
    EXTERNAL_WRITES_ENABLED: "false",
    LIVE_VALUE_MOVEMENT_ENABLED: "0",
    HUMAN_RECRUITMENT_B1_ENABLED: "off",
  });
  assert.equal(cfg.externalWritesEnabled, false);
  assert.equal(cfg.liveValueMovementEnabled, false);
  assert.equal(cfg.humanRecruitmentActivation.enabled, false);
});

test("config: a mode other than A is rejected", () => {
  assert.throws(() => loadConfig({ COMMERCE_MODE: "B" }), /Mode A/);
  assert.throws(() => loadConfig({ COMMERCE_MODE: "B1" }), /Mode A/);
  assert.doesNotThrow(() => loadConfig({ COMMERCE_MODE: "A" }));
});

test("config: absence of a gate never means enabled", () => {
  const cfg = loadConfig({ SOME_UNRELATED: "x" });
  assert.equal(cfg.externalWritesEnabled, false);
  assert.equal(cfg.liveValueMovementEnabled, false);
  assert.equal(cfg.humanRecruitmentActivation.enabled, false);
});

test("config: network bounds match the approved defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.network.connectTimeoutMs, 5_000);
  assert.equal(cfg.network.requestTimeoutMs, 15_000);
  assert.equal(cfg.network.adapterBudgetMs, 30_000);
  assert.equal(cfg.network.maxRetries, 2);
  assert.equal(cfg.network.maxRedirects, 5);
  assert.equal(cfg.network.maxResponseBytes, 5 * 1024 * 1024);
  assert.equal(cfg.concurrency, 3);
});

test("config: state and repo roots are absolute", () => {
  const cfg = loadConfig({});
  assert.ok(cfg.stateRoot.startsWith("/"), `stateRoot not absolute: ${cfg.stateRoot}`);
  assert.ok(cfg.repoRoot.startsWith("/"), `repoRoot not absolute: ${cfg.repoRoot}`);
  assert.match(cfg.stateRoot, /\.hermes\/commerce-control$/);
  assert.ok(cfg.databasePath.startsWith(cfg.stateRoot));
});

test("config: every platform has an enable flag defaulting to true", () => {
  const cfg = loadConfig({});
  for (const p of [
    "cdp_bazaar",
    "agent402",
    "piprail",
    "agent_bounties",
    "bountybook",
    "the402",
    "paysh",
  ] as const) {
    assert.equal(cfg.adapters[p].enabled, true, `${p} should default enabled`);
    assert.ok(cfg.adapters[p].baseUrl.startsWith("https://"), `${p} baseUrl must be https`);
  }
});

test("config: an adapter can be disabled by environment", () => {
  const cfg = loadConfig({ COMMERCE_DISABLE_THE402: "true" });
  assert.equal(cfg.adapters.the402.enabled, false);
  assert.equal(cfg.adapters.cdp_bazaar.enabled, true);
});

test("config: the config object carries no secret-valued field", () => {
  const cfg = loadConfig({
    PRIVATE_KEY: "0xdeadbeef",
    MNEMONIC: "test test test test test test test test test test test junk",
    NWC_URL: "nostr+walletconnect://abc",
    OPENAI_API_KEY: "sk-should-not-appear",
    PIPRAIL_PRIVATE_KEY: "0xabc",
  });
  const serialized = JSON.stringify(cfg);
  for (const forbidden of ["0xdeadbeef", "junk", "nostr+walletconnect", "sk-should-not-appear", "0xabc"]) {
    assert.equal(serialized.includes(forbidden), false, `config leaked ${forbidden}`);
  }
});

test("config: the secret env denylist covers the forbidden classes", () => {
  const joined = SECRET_ENV_DENYLIST.join("|").toLowerCase();
  for (const needle of ["private_key", "mnemonic", "seed", "nwc", "secret", "token", "api_key"]) {
    assert.ok(joined.includes(needle), `denylist missing ${needle}`);
  }
});

test("config: config is deeply frozen so callers cannot flip activation at runtime", () => {
  const cfg = loadConfig({});
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.network), true);
  assert.equal(Object.isFrozen(cfg.adapters), true);
  assert.equal(Object.isFrozen(cfg.humanRecruitmentActivation), true);
  assert.throws(() => {
    (cfg as unknown as { externalWritesEnabled: boolean }).externalWritesEnabled = true;
  });
  assert.throws(() => {
    (cfg.humanRecruitmentActivation as unknown as { enabled: boolean }).enabled = true;
  });
});
