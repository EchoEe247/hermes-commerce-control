import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { evaluatePolicy, assertAllowed } from "../src/policy/engine.js";
import { OPERATION_CLASSES } from "../src/policy/modes.js";

const cfg = loadConfig({});
const APPROVED_INTENT = "hintent_0123456789abcdef0123456789abcdef";
const recruitmentCfg = loadConfig({
  HUMAN_RECRUITMENT_B1_ENABLED: "true",
  HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: APPROVED_INTENT,
});

test("policy: READ is allowed", () => {
  const d = evaluatePolicy(cfg, { operation: "commerce_discover_services", class: "READ" });
  assert.equal(d.decision, "allow");
  assert.equal(d.mode, "A");
});

test("policy: LOCAL_WRITE is allowed", () => {
  const d = evaluatePolicy(cfg, { operation: "state_persist", class: "LOCAL_WRITE" });
  assert.equal(d.decision, "allow");
});

test("policy: PREPARE_EXTERNAL_ACTION is allowed", () => {
  const d = evaluatePolicy(cfg, {
    operation: "commerce_prepare_purchase",
    class: "PREPARE_EXTERNAL_ACTION",
  });
  assert.equal(d.decision, "allow");
});

test("policy: EXTERNAL_WRITE is blocked with EXTERNAL_WRITE_DISABLED", () => {
  const d = evaluatePolicy(cfg, { operation: "publish_listing", class: "EXTERNAL_WRITE" });
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(d.requiredActivation, "B1");
});

test("policy: exact recruitment intent can be allowed without opening general external writes", () => {
  const allowed = evaluatePolicy(recruitmentCfg, {
    operation: "human_recruitment_post",
    class: "EXTERNAL_WRITE",
    platform: "human_recruitment:reddit",
    mutatesExternal: true,
    externalIntentId: APPROVED_INTENT,
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.rule, "B1_HUMAN_RECRUITMENT_EXACT_INTENT");
  assert.equal(allowed.reason, null);

  const wrongIntent = evaluatePolicy(recruitmentCfg, {
    operation: "human_recruitment_post",
    class: "EXTERNAL_WRITE",
    platform: "human_recruitment:reddit",
    mutatesExternal: true,
    externalIntentId: "hintent_ffffffffffffffffffffffffffffffff",
  });
  assert.equal(wrongIntent.decision, "block");
  assert.equal(wrongIntent.reason, "EXTERNAL_WRITE_NOT_AUTHORIZED");

  const unrelatedWrite = evaluatePolicy(recruitmentCfg, {
    operation: "publish_listing",
    class: "EXTERNAL_WRITE",
    platform: "cdp_bazaar",
    mutatesExternal: true,
    externalIntentId: APPROVED_INTENT,
  });
  assert.equal(unrelatedWrite.decision, "block");
  assert.equal(unrelatedWrite.reason, "EXTERNAL_WRITE_DISABLED");
});

test("policy: recruitment grant cannot authorize signer access or value movement", () => {
  const signer = evaluatePolicy(recruitmentCfg, {
    operation: "human_recruitment_post",
    class: "EXTERNAL_WRITE",
    platform: "human_recruitment:reddit",
    mutatesExternal: true,
    requiresSigner: true,
    externalIntentId: APPROVED_INTENT,
  });
  assert.equal(signer.decision, "block");
  assert.equal(signer.reason, "SECRET_ACCESS_FORBIDDEN");

  const value = evaluatePolicy(recruitmentCfg, {
    operation: "human_recruitment_post",
    class: "EXTERNAL_WRITE",
    platform: "human_recruitment:reddit",
    mutatesExternal: true,
    movesValue: true,
    externalIntentId: APPROVED_INTENT,
  });
  assert.equal(value.decision, "block");
  assert.equal(value.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
});

test("policy: VALUE_MOVEMENT is blocked with LIVE_VALUE_MOVEMENT_DISABLED", () => {
  const d = evaluatePolicy(cfg, { operation: "settle_x402", class: "VALUE_MOVEMENT" });
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
  assert.equal(d.requiredActivation, "B2");
});

test("policy: SECRET_ACCESS is blocked with SECRET_ACCESS_FORBIDDEN", () => {
  const d = evaluatePolicy(cfg, { operation: "read_private_key", class: "SECRET_ACCESS" });
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "SECRET_ACCESS_FORBIDDEN");
  assert.equal(d.requiredActivation, null);
});

test("policy: TESTNET_ACTION is allowed only when no signer/value/mutation is requested", () => {
  const clean = evaluatePolicy(cfg, {
    operation: "fake_facilitator_verify",
    class: "TESTNET_ACTION",
  });
  assert.equal(clean.decision, "allow");

  const withSigner = evaluatePolicy(cfg, {
    operation: "sepolia_signed_payment",
    class: "TESTNET_ACTION",
    requiresSigner: true,
  });
  assert.equal(withSigner.decision, "block");
  assert.equal(withSigner.reason, "SECRET_ACCESS_FORBIDDEN");

  const withValue = evaluatePolicy(cfg, {
    operation: "sepolia_transfer",
    class: "TESTNET_ACTION",
    movesValue: true,
  });
  assert.equal(withValue.decision, "block");
  assert.equal(withValue.reason, "LIVE_VALUE_MOVEMENT_DISABLED");

  const withMutation = evaluatePolicy(cfg, {
    operation: "testnet_register",
    class: "TESTNET_ACTION",
    mutatesExternal: true,
  });
  assert.equal(withMutation.decision, "block");
  assert.equal(withMutation.reason, "EXTERNAL_WRITE_DISABLED");
});

test("policy: a signer or value flag blocks even an otherwise-READ operation", () => {
  const d = evaluatePolicy(cfg, {
    operation: "discover_but_sneakily_signs",
    class: "READ",
    requiresSigner: true,
  });
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "SECRET_ACCESS_FORBIDDEN");

  const v = evaluatePolicy(cfg, {
    operation: "quote_but_pays",
    class: "READ",
    movesValue: true,
  });
  assert.equal(v.decision, "block");
  assert.equal(v.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
});

test("policy: mainnet value movement is blocked regardless of network", () => {
  for (const network of ["eip155:8453", "eip155:1", "solana:mainnet"]) {
    const d = evaluatePolicy(cfg, {
      operation: "pay",
      class: "VALUE_MOVEMENT",
      network,
    });
    assert.equal(d.decision, "block", `${network} must be blocked`);
  }
});

test("policy: every declared operation class has a deterministic decision", () => {
  for (const cls of OPERATION_CLASSES) {
    const d = evaluatePolicy(cfg, { operation: `probe_${cls}`, class: cls });
    assert.ok(d.decision === "allow" || d.decision === "block", `${cls} produced ${d.decision}`);
    assert.equal(typeof d.rule, "string");
    assert.ok(d.rule.length > 0);
    assert.equal(d.operation, `probe_${cls}`);
    assert.equal(typeof d.evaluatedAt, "string");
  }
});

test("policy: an unknown operation class fails closed", () => {
  const d = evaluatePolicy(cfg, {
    operation: "mystery",
    class: "NOT_A_REAL_CLASS" as never,
  });
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "POLICY_BLOCKED");
});

test("policy: decisions are frozen and machine-readable", () => {
  const d = evaluatePolicy(cfg, { operation: "x", class: "READ" });
  assert.equal(Object.isFrozen(d), true);
  const round = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  for (const key of ["decision", "rule", "operation", "class", "mode", "evaluatedAt"]) {
    assert.ok(key in round, `decision missing ${key}`);
  }
});

test("policy: assertAllowed throws a typed error for a blocked operation", () => {
  assert.throws(
    () => assertAllowed(cfg, { operation: "pay", class: "VALUE_MOVEMENT" }),
    /LIVE_VALUE_MOVEMENT_DISABLED/,
  );
  assert.doesNotThrow(() => assertAllowed(cfg, { operation: "read", class: "READ" }));
});

test("policy: there is no override input that unblocks value movement", () => {
  const hostile = {
    operation: "pay",
    class: "VALUE_MOVEMENT" as const,
    force: true,
    override: true,
    approved: true,
    EXTERNAL_WRITES_ENABLED: true,
    LIVE_VALUE_MOVEMENT_ENABLED: true,
    policy: "allow",
    decision: "allow",
  };
  const d = evaluatePolicy(recruitmentCfg, hostile as never);
  assert.equal(d.decision, "block");
  assert.equal(d.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
});
