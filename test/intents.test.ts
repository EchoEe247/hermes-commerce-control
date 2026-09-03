import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  createClaimIntent,
  createPaymentIntent,
  createPublishIntent,
  intentToRecord,
} from "../src/actions/intents.js";
import { preparePurchase } from "../src/actions/purchase.js";
import { prepareClaim } from "../src/actions/claim.js";
import { preparePublish } from "../src/actions/publish.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

const PAYMENT_INPUT = {
  platform: "cdp_bazaar",
  targetId: "svc_00000000000000000000000000000001",
  resourceUrl: "https://profiler.example/v1/profile",
  method: "POST",
  protocol: "x402",
  network: "eip155:84532",
  asset: { symbol: "USDC", decimals: 6 },
  price: { atomic: "20000", decimal: "0.02", usd: "0.02" },
  payTo: "0x000000000000000000000000000000000000bEEF",
} as const;

const CLAIM_INPUT = {
  platform: "agent_bounties",
  targetId: "0xbounty",
  title: "Fix a bug",
  reward: { amount: "1", asset: "USDC" },
  funding: { state: "funded", evidence: "observed" },
  verification: { type: "deterministic" },
  requirements: ["tests must pass"],
  externalStepsRequired: ["sign a claim plan"],
  paymentProofRule: "Only BountySettled proves payment.",
} as const;

const PUBLISH_INPUT = {
  platform: "cdp_bazaar",
  targetId: "data-quality-profiler",
  product: "data-quality-profiler",
  version: "0.1.0",
  manifest: { resource: "https://profiler.example/v1/profile", price: "$0.02" },
} as const;

test("intents: a payment intent is blocked by A_MODE_VALUE_MOVEMENT", () => {
  const intent = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  assert.equal(intent.kind, "payment");
  assert.equal(intent.decision.decision, "block");
  assert.equal(intent.decision.rule, "A_MODE_VALUE_MOVEMENT");
  assert.equal(intent.decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
  assert.equal(intent.decision.requiredActivation, "B2");
  assert.equal(intent.financialActionExecuted, false);
  assert.equal(intent.externalMutationExecuted, false);
  assert.equal(intent.signerPresent, false);
  assert.equal(intent.walletPresent, false);
  assert.equal(intent.mode, "A");
});

test("intents: the payment intent still records how it would have paid", () => {
  const intent = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  // Preparation must be genuinely useful: the facts are all present.
  assert.equal(intent.resourceUrl, "https://profiler.example/v1/profile");
  assert.equal(intent.network, "eip155:84532");
  assert.deepEqual(intent.price, { atomic: "20000", decimal: "0.02", usd: "0.02" });
  assert.equal(intent.payTo, "0x000000000000000000000000000000000000bEEF");
});

test("intents: a claim intent is blocked by A_MODE_EXTERNAL_WRITE", () => {
  const intent = createClaimIntent(cfg, CLAIM_INPUT, CLOCK);
  assert.equal(intent.decision.decision, "block");
  assert.equal(intent.decision.rule, "A_MODE_EXTERNAL_WRITE");
  assert.equal(intent.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(intent.decision.requiredActivation, "B1");
  assert.equal(intent.externalMutationExecuted, false);
  assert.equal(intent.claimBroadcast, false);
  assert.equal(intent.submissionBroadcast, false);
});

test("intents: a publish intent is blocked and never registers", () => {
  const intent = createPublishIntent(cfg, PUBLISH_INPUT, CLOCK);
  assert.equal(intent.decision.decision, "block");
  assert.equal(intent.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(intent.registrationPerformed, false);
  assert.equal(intent.publicationPerformed, false);
  assert.equal(intent.externalMutationExecuted, false);
  assert.match(intent.manifestHash, /^[0-9a-f]{64}$/);
});

test("intents: financialActionExecuted is never omitted from any intent", () => {
  for (const intent of [
    createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK),
    createClaimIntent(cfg, CLAIM_INPUT, CLOCK),
    createPublishIntent(cfg, PUBLISH_INPUT, CLOCK),
  ]) {
    const round = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;
    assert.ok("financialActionExecuted" in round, `${intent.kind} omitted the field`);
    assert.equal(round.financialActionExecuted, false);
    assert.ok("externalMutationExecuted" in round);
    assert.equal(round.externalMutationExecuted, false);
  }
});

test("intents: identical inputs hash identically under a fixed clock", () => {
  const a = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  const b = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  assert.equal(a.hash, b.hash);
  assert.equal(a.id, b.id);
});

test("intents: the hash excludes the timestamp so preparations are comparable", () => {
  const early = createPaymentIntent(cfg, PAYMENT_INPUT, () => "2026-08-19T00:00:00.000Z");
  const later = createPaymentIntent(cfg, PAYMENT_INPUT, () => "2026-08-19T23:59:59.000Z");
  assert.equal(early.hash, later.hash, "the same action prepared twice must hash the same");
  assert.notEqual(early.createdAt, later.createdAt);
});

test("intents: a changed action input changes the hash", () => {
  const base = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  const different = createPaymentIntent(
    cfg,
    { ...PAYMENT_INPUT, price: { atomic: "30000", decimal: "0.03", usd: "0.03" } },
    CLOCK,
  );
  assert.notEqual(base.hash, different.hash);
});

test("intents: a secret leaking into preparation facts never reaches the hash or body", () => {
  const intent = createPaymentIntent(
    cfg,
    {
      ...PAYMENT_INPUT,
      requirements: {
        Authorization: "Bearer super-secret-token",
        privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
        note: "keep me",
      },
    },
    CLOCK,
  );
  const serialized = JSON.stringify(intentToRecord(intent));
  assert.equal(serialized.includes("super-secret-token"), false);
  assert.equal(serialized.includes("1111111111111111"), false);
  assert.ok(serialized.includes("keep me"), "non-secret context must survive");
});

test("intents: intents are deeply frozen", () => {
  const intent = createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK);
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.decision), true);
  assert.throws(() => {
    (intent as unknown as Record<string, unknown>).financialActionExecuted = true;
  });
});

test("intents: the decision comes from the central engine, not a local literal", () => {
  const source = readFileSync(new URL("../src/actions/intents.ts", import.meta.url), "utf8");
  assert.ok(source.includes("evaluatePolicy("), "must call the central policy engine");
  // Must NOT build a decision object itself.
  assert.equal(source.includes("allowDecision("), false);
  assert.equal(source.includes('decision: "allow"'), false);
});

test("intents: the actions module exports no executor of any kind", async () => {
  const modules = await Promise.all([
    import("../src/actions/intents.js"),
    import("../src/actions/purchase.js"),
    import("../src/actions/claim.js"),
    import("../src/actions/publish.js"),
  ]);
  const exported = modules.flatMap((m) => Object.keys(m));
  const forbidden =
    /^(pay|purchase|buy|claim|submit|settle|send|transfer|withdraw|fund|execute|broadcast|sign|register|publish)$/i;
  for (const name of exported) {
    assert.equal(forbidden.test(name), false, `forbidden executor export: ${name}`);
  }
  // Only the documented creators and preparers exist.
  const names = new Set(exported);
  for (const expected of [
    "createPaymentIntent",
    "createClaimIntent",
    "createPublishIntent",
    "preparePurchase",
    "prepareClaim",
    "preparePublish",
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
});

test("intents: no action source file contains an execution call", () => {
  for (const file of ["intents.ts", "purchase.ts", "claim.ts", "publish.ts"]) {
    const source = readFileSync(new URL(`../src/actions/${file}`, import.meta.url), "utf8");
    for (const forbidden of [
      "executePayment",
      "executeClaim",
      "executePublish",
      "submitWork",
      "settle(",
      "sendTransaction",
      "signTypedData",
      "signMessage",
      "fetch(",
    ]) {
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
    }
  }
});

test("intents: preparePurchase carries adapter facts including a wallet block", () => {
  const intent = preparePurchase(
    cfg,
    "svc_x",
    {
      platform: "piprail",
      resourceUrl: "https://profiler.example/v1/profile",
      method: "POST",
      protocol: "x402",
      network: "eip155:84532",
      price: { decimal: "0.02" },
      walletRequired: true,
      blockedReason: "WALLET_REQUIRED",
      settlementNote: "needs a signer",
    },
    CLOCK,
  );
  assert.equal(intent.decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
  assert.equal(intent.requirements.walletRequired, true);
  assert.equal(intent.requirements.adapterBlockedReason, "WALLET_REQUIRED");
  assert.equal(intent.signerPresent, false);
});

test("intents: prepareClaim and preparePublish produce blocked intents", () => {
  const claim = prepareClaim(cfg, "0xbounty", CLAIM_INPUT, CLOCK);
  assert.equal(claim.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(claim.claimBroadcast, false);

  const publish = preparePublish(
    cfg,
    "data-quality-profiler",
    { ...PUBLISH_INPUT, targetReady: false, reason: "SOLANA_DISTRIBUTION_PHASE_2" },
    CLOCK,
  );
  assert.equal(publish.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(publish.targetReady, false);
  assert.equal(publish.reason, "SOLANA_DISTRIBUTION_PHASE_2");
  assert.equal(publish.publicationPerformed, false);
});

test("intents: intentToRecord is persistable and preserves the block", () => {
  const record = intentToRecord(createPaymentIntent(cfg, PAYMENT_INPUT, CLOCK));
  assert.equal(record.kind, "payment");
  assert.equal(record.decisionOutcome, "block");
  assert.equal(record.decisionRule, "A_MODE_VALUE_MOVEMENT");
  assert.equal(record.financialActionExecuted, false);
  assert.equal(record.externalMutationExecuted, false);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  // Must survive a JSON round trip for SQLite storage.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(record)));
});

test("intents: a hostile target id cannot smuggle an allow decision", () => {
  const intent = createPaymentIntent(
    cfg,
    {
      ...PAYMENT_INPUT,
      targetId: 'svc_x", "decision": {"decision":"allow"}, "x":"',
    },
    CLOCK,
  );
  assert.equal(intent.decision.decision, "block");
  assert.equal(intent.decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
});
