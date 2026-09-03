import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  buildGiveGigsRecruitmentTarget,
  GIVEGIGS_TASKS_ENDPOINT,
  GiveGigsHumanRecruitmentTransport,
  giveGigsPostingBinding,
  JsonlGiveGigsIdempotencyStore,
  type GiveGigsPostingConfig,
} from "../src/opportunities/givegigs-recruitment-transport.js";
import type { HumanFulfillmentContractDraft } from "../src/opportunities/human-fulfillment.js";
import { buildHumanRecruitmentPayload } from "../src/opportunities/human-recruitment-adapters.js";
import { executeHumanRecruitmentAction } from "../src/opportunities/human-recruitment-executor.js";
import { createHumanRecruitmentActionIntent } from "../src/opportunities/human-recruitment-intent.js";

const REMOTE_CONTRACT: HumanFulfillmentContractDraft = {
  schemaVersion: 1,
  policyVersion: 1,
  contractId: "hcontract_givegigs_remote",
  recruitmentDraftId: "hrecruit_givegigs_remote",
  opportunityId: "opp_givegigs_remote",
  kind: "remote",
  terms: {
    workerReference: "candidate-pending",
    taskBrief: "Test a web onboarding flow as a real human and document each confusing step.",
    acceptanceCriteria: ["Complete the onboarding flow once", "Describe each confusing step clearly"],
    evidenceRequirements: ["Return a timestamped written report", "Include screenshots of any blocking issue"],
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

const REMOTE_POSTING: GiveGigsPostingConfig = {
  contactMethods: "Apply through the GiveGigs task page; accepted applicants coordinate in GiveGigs chat.",
  paymentMethod: "Direct off-site payment using the payment method confirmed with the worker before acceptance.",
  skillsNeeded: "usability testing, written feedback",
  urgency: "NORMAL",
  locationType: "REMOTE",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function exactConfigForPayload(payload: ReturnType<typeof buildHumanRecruitmentPayload>) {
  const prepared = createHumanRecruitmentActionIntent(loadConfig({}), payload, () => "2026-08-30T12:01:00.000Z");
  return {
    prepared,
    config: loadConfig({
      HUMAN_RECRUITMENT_B1_ENABLED: "true",
      HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID: prepared.intentId,
    }),
  };
}

test("GiveGigs target binding freezes worker-visible posting configuration into the exact B1 intent", () => {
  const target = buildGiveGigsRecruitmentTarget(REMOTE_POSTING, "2026-08-30T12:00:00.000Z");
  assert.equal(target.channel, "marketplace");
  assert.equal(target.delivery, "public_post");
  assert.equal(target.target, giveGigsPostingBinding(REMOTE_POSTING));
  assert.match(target.target, /^givegigs:offsite-pay:[0-9a-f]{32}$/);

  const changedPayment: GiveGigsPostingConfig = {
    ...REMOTE_POSTING,
    paymentMethod: "A different worker-visible payment method",
  };
  const changedContact: GiveGigsPostingConfig = {
    ...REMOTE_POSTING,
    contactMethods: "A different contact route",
  };
  assert.notEqual(giveGigsPostingBinding(changedPayment), target.target);
  assert.notEqual(giveGigsPostingBinding(changedContact), target.target);
});

test("exact-B1 GiveGigs execution posts OFFSITE_PAY once and replays locally without a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "givegigs-transport-"));
  const journalPath = join(root, "idempotency.jsonl");
  const apiKey = "givegigs-super-secret-test-key";
  try {
    const target = buildGiveGigsRecruitmentTarget(REMOTE_POSTING, "2026-08-30T12:00:00.000Z");
    const payload = buildHumanRecruitmentPayload(REMOTE_CONTRACT, target);
    const { prepared, config } = exactConfigForPayload(payload);
    let fetchCalls = 0;
    let observedBody: Record<string, unknown> | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls += 1;
      assert.equal(String(url), GIVEGIGS_TASKS_ENDPOINT);
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-api-key"), apiKey);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(typeof init?.body, "string");
      observedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({
        success: true,
        task: { taskId: "task_abc123" },
        taskUrl: "https://givegigs.com/ai/gigs/tasks/task_abc123",
        updatedExisting: false,
      });
    }) as typeof fetch;

    const store = new JsonlGiveGigsIdempotencyStore(journalPath);
    const transport = new GiveGigsHumanRecruitmentTransport({
      posting: REMOTE_POSTING,
      apiKeyProvider: () => apiKey,
      idempotencyStore: store,
      fetchImpl: fakeFetch,
      clock: () => "2026-08-30T12:03:00.000Z",
    });

    const first = await executeHumanRecruitmentAction(
      config,
      payload,
      prepared,
      transport,
      () => "2026-08-30T12:02:00.000Z",
    );
    assert.equal(first.externalReference, "https://givegigs.com/ai/gigs/tasks/task_abc123");
    assert.equal(first.boundary.externalMutationExecuted, true);
    assert.equal(first.boundary.liveValueMovementExecuted, false);
    assert.equal(fetchCalls, 1);
    assert.equal(observedBody?.fundingType, "OFFSITE_PAY");
    assert.equal(observedBody?.promisedAmount, "40.00");
    assert.equal(observedBody?.currency, "USD");
    assert.equal(observedBody?.contactMethods, REMOTE_POSTING.contactMethods);
    assert.equal(observedBody?.paymentMethod, REMOTE_POSTING.paymentMethod);
    assert.equal(observedBody?.locationType, "REMOTE");
    assert.equal(observedBody?.skillsNeeded, REMOTE_POSTING.skillsNeeded);

    const replay = await executeHumanRecruitmentAction(
      config,
      payload,
      prepared,
      transport,
      () => "2026-08-30T12:04:00.000Z",
    );
    assert.equal(replay.externalReference, first.externalReference);
    assert.equal(fetchCalls, 1, "completed exact intent must not create a duplicate GiveGigs task");

    const journal = await readFile(journalPath, "utf8");
    assert.match(journal, /"event":"claimed"/);
    assert.match(journal, /"event":"completed"/);
    assert.equal(journal.includes(apiKey), false, "API key must never enter the idempotency journal");
    assert.equal(journal.includes(REMOTE_POSTING.paymentMethod), false, "worker-facing posting text is represented by hash only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GiveGigs physical recruitment requires explicit LOCAL coordinates and country", async () => {
  const root = await mkdtemp(join(tmpdir(), "givegigs-local-"));
  try {
    const physicalContract: HumanFulfillmentContractDraft = {
      ...REMOTE_CONTRACT,
      contractId: "hcontract_givegigs_physical",
      recruitmentDraftId: "hrecruit_givegigs_physical",
      opportunityId: "opp_givegigs_physical",
      kind: "physical",
      terms: {
        ...REMOTE_CONTRACT.terms,
        taskBrief: "Visit the specified storefront and photograph the public entrance signage.",
      },
    };
    const badTarget = buildGiveGigsRecruitmentTarget(REMOTE_POSTING, "2026-08-30T12:00:00.000Z");
    const badPayload = buildHumanRecruitmentPayload(physicalContract, badTarget);
    const bad = exactConfigForPayload(badPayload);
    let badFetchCalls = 0;
    const badTransport = new GiveGigsHumanRecruitmentTransport({
      posting: REMOTE_POSTING,
      apiKeyProvider: () => "givegigs-key",
      idempotencyStore: new JsonlGiveGigsIdempotencyStore(join(root, "bad.jsonl")),
      fetchImpl: (async (): Promise<Response> => {
        badFetchCalls += 1;
        return jsonResponse({ success: true, taskUrl: "https://givegigs.com/ai/gigs/tasks/should-not-run" });
      }) as typeof fetch,
    });
    await assert.rejects(
      executeHumanRecruitmentAction(
        bad.config,
        badPayload,
        bad.prepared,
        badTransport,
        () => "2026-08-30T12:02:00.000Z",
      ),
      /physical human recruitment requires a LOCAL/,
    );
    assert.equal(badFetchCalls, 0);

    const localPosting: GiveGigsPostingConfig = {
      ...REMOTE_POSTING,
      locationType: "LOCAL",
      latitude: 26.2034,
      longitude: -98.2300,
      country: "United States",
      locationName: "McAllen, Texas",
      locationRadiusKm: 15,
    };
    const localTarget = buildGiveGigsRecruitmentTarget(localPosting, "2026-08-30T12:00:00.000Z");
    const localPayload = buildHumanRecruitmentPayload(physicalContract, localTarget);
    const local = exactConfigForPayload(localPayload);
    let localBody: Record<string, unknown> | undefined;
    const localTransport = new GiveGigsHumanRecruitmentTransport({
      posting: localPosting,
      apiKeyProvider: () => "givegigs-key",
      idempotencyStore: new JsonlGiveGigsIdempotencyStore(join(root, "local.jsonl")),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        localBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return jsonResponse({ success: true, taskUrl: "https://givegigs.com/ai/gigs/tasks/task_local" });
      }) as typeof fetch,
      clock: () => "2026-08-30T12:03:00.000Z",
    });
    await executeHumanRecruitmentAction(
      local.config,
      localPayload,
      local.prepared,
      localTransport,
      () => "2026-08-30T12:02:00.000Z",
    );
    assert.equal(localBody?.locationType, "LOCAL");
    assert.equal(localBody?.latitude, 26.2034);
    assert.equal(localBody?.longitude, -98.23);
    assert.equal(localBody?.country, "United States");
    assert.equal(localBody?.locationRadius, 15);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("definitive GiveGigs 4xx releases the local claim so a corrected credential can retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "givegigs-retry-"));
  try {
    const target = buildGiveGigsRecruitmentTarget(REMOTE_POSTING, "2026-08-30T12:00:00.000Z");
    const payload = buildHumanRecruitmentPayload(REMOTE_CONTRACT, target);
    const { prepared, config } = exactConfigForPayload(payload);
    let calls = 0;
    let apiKey = "givegigs-old-key";
    const transport = new GiveGigsHumanRecruitmentTransport({
      posting: REMOTE_POSTING,
      apiKeyProvider: () => apiKey,
      idempotencyStore: new JsonlGiveGigsIdempotencyStore(join(root, "idempotency.jsonl")),
      fetchImpl: (async (): Promise<Response> => {
        calls += 1;
        if (calls === 1) return jsonResponse({ success: false, error: "Invalid API key" }, 401);
        return jsonResponse({ success: true, taskUrl: "https://givegigs.com/ai/gigs/tasks/task_retry" });
      }) as typeof fetch,
      clock: () => "2026-08-30T12:03:00.000Z",
    });

    await assert.rejects(
      executeHumanRecruitmentAction(
        config,
        payload,
        prepared,
        transport,
        () => "2026-08-30T12:02:00.000Z",
      ),
      /HTTP 401/,
    );
    apiKey = "givegigs-new-key";
    const receipt = await executeHumanRecruitmentAction(
      config,
      payload,
      prepared,
      transport,
      () => "2026-08-30T12:04:00.000Z",
    );
    assert.equal(receipt.externalReference, "https://givegigs.com/ai/gigs/tasks/task_retry");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous GiveGigs failure stays pending and blocks automatic duplicate retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "givegigs-ambiguous-"));
  const journalPath = join(root, "idempotency.jsonl");
  try {
    const target = buildGiveGigsRecruitmentTarget(REMOTE_POSTING, "2026-08-30T12:00:00.000Z");
    const payload = buildHumanRecruitmentPayload(REMOTE_CONTRACT, target);
    const { prepared, config } = exactConfigForPayload(payload);
    let calls = 0;
    const transport = new GiveGigsHumanRecruitmentTransport({
      posting: REMOTE_POSTING,
      apiKeyProvider: () => "givegigs-key",
      idempotencyStore: new JsonlGiveGigsIdempotencyStore(journalPath),
      fetchImpl: (async (): Promise<Response> => {
        calls += 1;
        return jsonResponse({ success: false, error: "server uncertainty" }, 500);
      }) as typeof fetch,
      clock: () => "2026-08-30T12:03:00.000Z",
    });

    await assert.rejects(
      executeHumanRecruitmentAction(
        config,
        payload,
        prepared,
        transport,
        () => "2026-08-30T12:02:00.000Z",
      ),
      /HTTP 500/,
    );
    await assert.rejects(
      executeHumanRecruitmentAction(
        config,
        payload,
        prepared,
        transport,
        () => "2026-08-30T12:04:00.000Z",
      ),
      /unresolved prior POST/,
    );
    assert.equal(calls, 1, "ambiguous retry must stop before another remote POST");
    const journal = await readFile(journalPath, "utf8");
    assert.equal(journal.includes('"event":"completed"'), false);
    assert.equal(journal.includes('"event":"released"'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
