import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { HumanFulfillmentContractDraft } from "../src/opportunities/human-fulfillment.js";
import {
  buildHumanRecruitmentPayload,
  type HumanRecruitmentPayload,
} from "../src/opportunities/human-recruitment-adapters.js";
import { createHumanRecruitmentActionIntent } from "../src/opportunities/human-recruitment-intent.js";
import {
  executeHumanRecruitmentAction,
  type HumanRecruitmentTransport,
} from "../src/opportunities/human-recruitment-executor.js";
import {
  createHumanFulfillmentLifecycleEvent,
  JsonlHumanFulfillmentLifecycleStore,
} from "../src/opportunities/human-fulfillment-lifecycle.js";

const CONTRACT: HumanFulfillmentContractDraft = {
  schemaVersion: 1,
  policyVersion: 1,
  contractId: "hcontract_test",
  recruitmentDraftId: "hrecruit_test",
  opportunityId: "opp_test",
  kind: "remote",
  terms: {
    workerReference: "candidate-17",
    taskBrief: "Verify ten storefront listings against the supplied checklist.",
    acceptanceCriteria: ["All ten listings checked", "Each discrepancy is documented"],
    evidenceRequirements: ["Return one completed checklist", "Include URLs for discrepancies"],
    fullCompensationUsd: 40,
    goodFaithAttemptCompensationUsd: 10,
    dueAt: "2026-08-31T18:00:00.000Z",
  },
  financial: {
    upstreamPayout: { minUsd: 100, maxUsd: null, basis: "observed" },
    grossMarginFloorUsd: 60,
    paymentAuthorizationReady: true,
    blockers: [],
  },
  compensationPolicy: {
    accepted: "full_agreed_compensation",
    goodFaithFailed: "contract_defined_partial_compensation",
    noMeaningfulEffort: "no_compensation",
    establishedFraud: "no_compensation",
    suspicious: "manual_review_no_automatic_denial",
  },
  boundary: {
    contractIsDraft: true,
    workerAcceptanceRequired: true,
    explicitFinancialAuthorizationRequired: true,
    paymentExecutionAllowed: false,
  },
};

function redditPayload(rulesVerifiedAt = "2026-08-30T10:00:00.000Z"): HumanRecruitmentPayload {
  return buildHumanRecruitmentPayload(CONTRACT, {
    channel: "reddit",
    target: "r/forhire",
    rulesVerifiedAt,
  });
}

test("reddit adapter emits only frozen worker terms, not internal upstream economics or source metadata", () => {
  const payload = redditPayload();
  assert.equal(payload.channel, "reddit");
  assert.equal(payload.delivery, "public_post");
  assert.match(payload.rendered.title, /^\[HIRING\]/);
  assert.match(payload.rendered.body, /\$40\.00/);
  assert.match(payload.rendered.body, /\$10\.00/);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("100"), false, "upstream payout must not leak into worker payload");
  assert.equal(serialized.includes("candidate-17"), false, "internal worker reference must not leak");
  assert.equal(payload.boundary.externalActionsAllowed, false);
});

test("direct adapter is private-message only", () => {
  const payload = buildHumanRecruitmentPayload(CONTRACT, {
    channel: "direct",
    target: "known-candidate",
    rulesVerifiedAt: "2026-08-30T10:00:00.000Z",
  });
  assert.equal(payload.delivery, "private_message");
  assert.throws(() =>
    buildHumanRecruitmentPayload(CONTRACT, {
      channel: "direct",
      target: "known-candidate",
      rulesVerifiedAt: "2026-08-30T10:00:00.000Z",
      delivery: "public_post",
    }),
  );
});

test("worker-facing payload is blocked when the economic case is not ready", () => {
  const blocked: HumanFulfillmentContractDraft = {
    ...CONTRACT,
    financial: {
      upstreamPayout: null,
      grossMarginFloorUsd: null,
      paymentAuthorizationReady: false,
      blockers: ["upstream total USD payout is not established"],
    },
  };
  assert.throws(() =>
    buildHumanRecruitmentPayload(blocked, {
      channel: "marketplace",
      target: "marketplace:test",
      rulesVerifiedAt: "2026-08-30T10:00:00.000Z",
    }),
  );
});

test("recruitment intent id is stable across blocked preparation and exact B1 activation", () => {
  const payload = redditPayload();
  const blocked = createHumanRecruitmentActionIntent(
    loadConfig({}),
    payload,
    () => "2026-08-30T10:05:00.000Z",
  );
  assert.equal(blocked.action, "post");
  assert.equal(blocked.decision.decision, "block");
  assert.equal(blocked.decision.rule, "A_MODE_EXTERNAL_WRITE");
  assert.equal(blocked.decision.reason, "EXTERNAL_WRITE_DISABLED");
  assert.equal(blocked.boundary.externalMutationExecuted, false);

  const activeConfig = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: blocked.intentId,
  });
  const activated = createHumanRecruitmentActionIntent(
    activeConfig,
    payload,
    () => "2026-08-30T10:06:00.000Z",
  );
  assert.equal(activated.intentId, blocked.intentId);
  assert.equal(activated.decision.decision, "allow");
  assert.equal(activated.decision.rule, "B1_HUMAN_RECRUITMENT_EXACT_INTENT");
  assert.equal(activated.boundary.operatorApprovalRequired, true);
});

test("exact recruitment activation does not authorize a different worker payload", () => {
  const approvedPayload = redditPayload();
  const approvedIntent = createHumanRecruitmentActionIntent(loadConfig({}), approvedPayload);
  const cfg = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: approvedIntent.intentId,
  });
  const differentPayload = buildHumanRecruitmentPayload(CONTRACT, {
    channel: "marketplace",
    target: "worker-market:test",
    rulesVerifiedAt: "2026-08-30T10:00:00.000Z",
  });
  const differentIntent = createHumanRecruitmentActionIntent(cfg, differentPayload);
  assert.notEqual(differentIntent.intentId, approvedIntent.intentId);
  assert.equal(differentIntent.decision.decision, "block");
  assert.equal(differentIntent.decision.reason, "EXTERNAL_WRITE_NOT_AUTHORIZED");
});

test("executor performs only the exact approved intent and emits a non-financial receipt", async () => {
  const payload = redditPayload();
  const prepared = createHumanRecruitmentActionIntent(loadConfig({}), payload);
  const cfg = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: prepared.intentId,
  });
  let calls = 0;
  let observedIdempotencyKey = "";
  const transport: HumanRecruitmentTransport = {
    channel: "reddit",
    async execute(input) {
      calls += 1;
      observedIdempotencyKey = input.idempotencyKey;
      assert.equal(input.action, "post");
      assert.equal(input.target, "r/forhire");
      assert.match(input.body, /Full compensation/);
      return { externalReference: "reddit:post:t3_example" };
    },
  };

  const receipt = await executeHumanRecruitmentAction(
    cfg,
    payload,
    prepared,
    transport,
    () => "2026-08-30T10:10:00.000Z",
  );
  assert.equal(calls, 1);
  assert.equal(observedIdempotencyKey, prepared.intentId);
  assert.equal(receipt.intentId, prepared.intentId);
  assert.equal(receipt.externalReference, "reddit:post:t3_example");
  assert.equal(receipt.policyRule, "B1_HUMAN_RECRUITMENT_EXACT_INTENT");
  assert.equal(receipt.boundary.externalMutationExecuted, true);
  assert.equal(receipt.boundary.compensationExecutionAllowed, false);
  assert.equal(receipt.boundary.liveValueMovementExecuted, false);
});

test("executor fails closed before transport when activation or rules are invalid", async () => {
  const payload = redditPayload();
  const prepared = createHumanRecruitmentActionIntent(loadConfig({}), payload);
  let calls = 0;
  const transport: HumanRecruitmentTransport = {
    channel: "reddit",
    async execute() {
      calls += 1;
      return { externalReference: "should-not-run" };
    },
  };

  await assert.rejects(
    executeHumanRecruitmentAction(
      loadConfig({}),
      payload,
      prepared,
      transport,
      () => "2026-08-30T10:10:00.000Z",
    ),
    /blocked/,
  );
  assert.equal(calls, 0);

  const cfg = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: prepared.intentId,
  });
  const stalePayload = redditPayload("2026-08-20T10:00:00.000Z");
  const staleIntent = createHumanRecruitmentActionIntent(loadConfig({}), stalePayload);
  const staleCfg = loadConfig({
    HUMAN_RECRUITMENT_B1_ENABLED: "true",
    HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: staleIntent.intentId,
  });
  await assert.rejects(
    executeHumanRecruitmentAction(
      staleCfg,
      stalePayload,
      staleIntent,
      transport,
      () => "2026-08-30T10:10:00.000Z",
    ),
    /older than seven days/,
  );
  assert.equal(calls, 0);
  assert.equal(cfg.humanRecruitmentActivation.enabled, true);
});

test("human fulfillment lifecycle records external execution receipts append-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "human-lifecycle-"));
  const path = join(root, "events.jsonl");
  try {
    const store = new JsonlHumanFulfillmentLifecycleStore(path);
    const payload = redditPayload();
    const preparedIntent = createHumanRecruitmentActionIntent(loadConfig({}), payload);
    const prepared = createHumanFulfillmentLifecycleEvent({
      type: "recruitment_payload_prepared",
      opportunityId: "opp_test",
      occurredAt: "2026-08-30T10:00:00.000Z",
      contractId: CONTRACT.contractId,
      payloadId: payload.payloadId,
    });
    const executed = createHumanFulfillmentLifecycleEvent({
      type: "external_action_executed",
      opportunityId: "opp_test",
      occurredAt: "2026-08-30T10:10:00.000Z",
      contractId: CONTRACT.contractId,
      payloadId: payload.payloadId,
      intentId: preparedIntent.intentId,
      executionReceiptId: "hreceipt_0123456789abcdef0123456789abcdef",
      externalReference: "reddit:post:t3_example",
    });
    const candidate = createHumanFulfillmentLifecycleEvent({
      type: "candidate_recorded",
      opportunityId: "opp_test",
      occurredAt: "2026-08-30T10:20:00.000Z",
      candidateReference: "candidate-17",
    });
    assert.equal(await store.append(prepared), true);
    assert.equal(await store.append(prepared), false);
    assert.equal(await store.append(executed), true);
    assert.equal(await store.append(candidate), true);
    const rows = await store.list("opp_test");
    assert.equal(rows.length, 3);
    assert.equal(rows[1]?.type, "external_action_executed");
    assert.equal(rows[1]?.externalReference, "reddit:post:t3_example");
    assert.equal((await store.list("different")).length, 0);
    const body = await readFile(path, "utf8");
    assert.equal(body.trim().split("\n").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
