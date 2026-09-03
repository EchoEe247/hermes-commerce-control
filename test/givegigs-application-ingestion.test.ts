import assert from "node:assert/strict";
import test from "node:test";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  bindGiveGigsApplicationToContract,
  createGiveGigsCandidateRecordedEvent,
  giveGigsTaskIdFromReference,
  readGiveGigsApplications,
} from "../src/opportunities/givegigs-application-ingestion.js";
import {
  buildHumanCandidateQualificationPlan,
  evaluateHumanCandidateQualification,
} from "../src/opportunities/human-candidate-assignment.js";
import type { HumanFulfillmentContractDraft } from "../src/opportunities/human-fulfillment.js";

const TEMPLATE: HumanFulfillmentContractDraft = {
  schemaVersion: 1,
  policyVersion: 1,
  contractId: "hcontract_template",
  recruitmentDraftId: "hrecruit_givegigs",
  opportunityId: "opp_givegigs",
  kind: "remote",
  terms: {
    workerReference: "unbound-marketplace-candidate",
    taskBrief: "Verify ten public storefront records against the supplied checklist.",
    acceptanceCriteria: ["All ten records checked", "Every discrepancy documented"],
    evidenceRequirements: ["Return the completed checklist with source links"],
    fullCompensationUsd: 40,
    goodFaithAttemptCompensationUsd: 10,
    dueAt: "2026-09-01T18:00:00.000Z",
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

function safeFetchReturning(payload: unknown, calls: string[]): SafeFetch {
  return {
    async json<T = unknown>(url: string, init?: unknown): Promise<T> {
      calls.push(url);
      assert.equal(init, undefined, "public application reads must not attach request credentials/options");
      return payload as T;
    },
    async text(): Promise<never> {
      throw new Error("unexpected text call");
    },
  } as unknown as SafeFetch;
}

const TASK_REFERENCE = "https://givegigs.com/ai/gigs/tasks/task_123";

const TASK_DETAIL = {
  success: true,
  task: {
    taskId: "task_123",
    applications: [
      {
        id: "app_2",
        workerId: "worker_9",
        status: "PENDING",
        message: "I can complete this and have relevant experience.",
        createdAt: "2026-08-30T12:40:00.000Z",
      },
      {
        applicationId: "app_1",
        worker: { workerId: "worker_7" },
        status: "PENDING",
        coverLetter: "Available before the deadline.",
        appliedAt: "2026-08-30T12:35:00.000Z",
      },
      { id: "malformed_without_worker" },
    ],
  },
};

test("public GiveGigs task read normalizes applications without credentials or writes", async () => {
  const calls: string[] = [];
  const snapshot = await readGiveGigsApplications(safeFetchReturning(TASK_DETAIL, calls), TASK_REFERENCE);
  assert.deepEqual(calls, ["https://givegigs.com/api/ai/tasks/task_123"]);
  assert.equal(snapshot.taskId, "task_123");
  assert.equal(snapshot.applications.length, 2);
  assert.equal(snapshot.skippedApplicationCount, 1);
  assert.equal(snapshot.applications[0]?.providerWorkerId, "worker_7");
  assert.equal(snapshot.applications[0]?.candidateReference, "givegigs:worker:worker_7");
  assert.match(snapshot.applications[0]?.applicationReference ?? "", /^givegigs:application:[0-9a-f]{32}$/);
  assert.equal(snapshot.boundary.publicReadOnly, true);
  assert.equal(snapshot.boundary.authenticatedProviderRead, false);
  assert.equal(snapshot.boundary.providerWriteExecuted, false);
  assert.equal(snapshot.boundary.workerHired, false);
  assert.equal(snapshot.boundary.paymentExecutionAllowed, false);
});

test("task reference is fixed to the GiveGigs public task namespace before network access", async () => {
  assert.equal(giveGigsTaskIdFromReference(TASK_REFERENCE), "task_123");
  assert.throws(() => giveGigsTaskIdFromReference("https://evil.example/ai/gigs/tasks/task_123"), /namespace/);
  assert.throws(() => giveGigsTaskIdFromReference("https://givegigs.com/ai/gigs/tasks/task_123/extra"), /exactly one task/);

  let calls = 0;
  const safeFetch = {
    async json(): Promise<unknown> {
      calls += 1;
      return TASK_DETAIL;
    },
  } as unknown as SafeFetch;
  await assert.rejects(
    readGiveGigsApplications(safeFetch, "https://127.0.0.1/ai/gigs/tasks/task_123"),
    /namespace/,
  );
  assert.equal(calls, 0);
});

test("provider response must match the requested task and expose usable worker identity", async () => {
  const mismatch = {
    success: true,
    task: { taskId: "task_other", applications: [] },
  };
  await assert.rejects(
    readGiveGigsApplications(safeFetchReturning(mismatch, []), TASK_REFERENCE),
    /does not match requested task/,
  );

  const noUsableWorker = {
    success: true,
    task: { taskId: "task_123", applications: [{ id: "app_only" }] },
  };
  await assert.rejects(
    readGiveGigsApplications(safeFetchReturning(noUsableWorker, []), TASK_REFERENCE),
    /usable worker identity/,
  );
});

test("application binding changes only worker identity and deterministic contract id", async () => {
  const snapshot = await readGiveGigsApplications(safeFetchReturning(TASK_DETAIL, []), TASK_REFERENCE);
  const application = snapshot.applications[0];
  assert.ok(application !== undefined);
  const bound = bindGiveGigsApplicationToContract(TEMPLATE, application);

  assert.notEqual(bound.contractId, TEMPLATE.contractId);
  assert.match(bound.contractId, /^hcontract_[0-9a-f]{32}$/);
  assert.equal(bound.terms.workerReference, application.candidateReference);
  assert.equal(bound.terms.taskBrief, TEMPLATE.terms.taskBrief);
  assert.deepEqual(bound.terms.acceptanceCriteria, TEMPLATE.terms.acceptanceCriteria);
  assert.deepEqual(bound.terms.evidenceRequirements, TEMPLATE.terms.evidenceRequirements);
  assert.equal(bound.terms.fullCompensationUsd, TEMPLATE.terms.fullCompensationUsd);
  assert.equal(bound.terms.goodFaithAttemptCompensationUsd, TEMPLATE.terms.goodFaithAttemptCompensationUsd);
  assert.equal(bound.terms.dueAt, TEMPLATE.terms.dueAt);
  assert.deepEqual(bound.financial, TEMPLATE.financial);
  assert.deepEqual(bound.compensationPolicy, TEMPLATE.compensationPolicy);
  assert.deepEqual(bound.boundary, TEMPLATE.boundary);

  const repeated = bindGiveGigsApplicationToContract(TEMPLATE, application);
  assert.equal(repeated.contractId, bound.contractId);
});

test("bound GiveGigs candidate flows into the existing qualification model without auto-hiring", async () => {
  const snapshot = await readGiveGigsApplications(safeFetchReturning(TASK_DETAIL, []), TASK_REFERENCE);
  const application = snapshot.applications[0];
  assert.ok(application !== undefined);
  const contract = bindGiveGigsApplicationToContract(TEMPLATE, application);
  const plan = buildHumanCandidateQualificationPlan(contract, [
    {
      id: "can_verify_records",
      category: "capability",
      description: "Can verify the supplied public records against the checklist.",
      verification: "self_attestation",
    },
    {
      id: "sample_evidence",
      category: "other",
      description: "Provide one qualification evidence reference before assignment.",
      verification: "evidence_required",
    },
  ]);
  assert.equal(plan.candidateReference, application.candidateReference);

  const qualification = evaluateHumanCandidateQualification(plan, {
    candidateReference: application.candidateReference,
    submittedAt: "2026-08-30T13:00:00.000Z",
    canMeetDeadline: true,
    availableForCorrections: true,
    communicationAcknowledged: true,
    compensationTermsAcknowledged: true,
    responses: [
      { requirementId: "can_verify_records", satisfied: true },
      { requirementId: "sample_evidence", satisfied: true, evidenceReference: "qualification:sample:1" },
    ],
  });
  assert.equal(qualification.status, "qualified");
  assert.equal(qualification.boundary.assignmentAllowed, true);
  assert.equal(qualification.boundary.workerHired, false);
  assert.equal(qualification.boundary.paymentExecutionAllowed, false);
});

test("candidate lifecycle event persists provider linkage but not raw application message", async () => {
  const snapshot = await readGiveGigsApplications(safeFetchReturning(TASK_DETAIL, []), TASK_REFERENCE);
  const application = snapshot.applications[0];
  assert.ok(application !== undefined);
  const contract = bindGiveGigsApplicationToContract(TEMPLATE, application);
  const event = createGiveGigsCandidateRecordedEvent(
    contract,
    application,
    "2026-08-30T12:45:00.000Z",
  );
  assert.equal(event.type, "candidate_recorded");
  assert.equal(event.contractId, contract.contractId);
  assert.equal(event.candidateReference, application.candidateReference);
  assert.equal(event.externalReference, application.applicationReference);
  assert.equal(JSON.stringify(event).includes(application.message ?? "impossible-marker"), false);
  assert.equal(JSON.stringify(event).includes("I can complete this"), false);
});

test("candidate binding refuses a financially blocked template contract", async () => {
  const snapshot = await readGiveGigsApplications(safeFetchReturning(TASK_DETAIL, []), TASK_REFERENCE);
  const application = snapshot.applications[0];
  assert.ok(application !== undefined);
  const blocked: HumanFulfillmentContractDraft = {
    ...TEMPLATE,
    financial: {
      upstreamPayout: null,
      grossMarginFloorUsd: null,
      paymentAuthorizationReady: false,
      blockers: ["upstream payout is not established"],
    },
  };
  assert.throws(() => bindGiveGigsApplicationToContract(blocked, application), /economics.*viable/i);
});
