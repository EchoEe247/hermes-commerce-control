import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanFulfillmentContractDraft,
  HumanFulfillmentReviewRecord,
} from "../src/opportunities/human-fulfillment.js";
import {
  buildHumanCandidateQualificationPlan,
  buildHumanWorkerPerformanceRecord,
  createHumanFulfillmentAssignment,
  evaluateHumanCandidateQualification,
  recordHumanAssignmentDecision,
  type HumanCandidateRequirement,
} from "../src/opportunities/human-candidate-assignment.js";

const BASE_CONTRACT: HumanFulfillmentContractDraft = {
  schemaVersion: 1,
  policyVersion: 1,
  contractId: "hcontract_candidate_test",
  recruitmentDraftId: "hrecruit_candidate_test",
  opportunityId: "opp_candidate_test",
  kind: "remote",
  terms: {
    workerReference: "candidate-42",
    taskBrief: "Check a set of product listings and return the required evidence.",
    acceptanceCriteria: ["All required listings checked", "Corrections completed if requested"],
    evidenceRequirements: ["Completed checklist", "References for each discrepancy"],
    fullCompensationUsd: 30,
    goodFaithAttemptCompensationUsd: 8,
    dueAt: "2026-08-31T20:00:00.000Z",
  },
  financial: {
    upstreamPayout: { minUsd: 80, maxUsd: null, basis: "observed" },
    grossMarginFloorUsd: 50,
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

const REQUIREMENTS: readonly HumanCandidateRequirement[] = [
  {
    id: "browser_access",
    category: "capability",
    description: "Can use a modern browser and supplied checklist.",
    verification: "self_attestation",
  },
  {
    id: "sample_evidence",
    category: "capability",
    description: "Provide one sample showing the required evidence format.",
    verification: "evidence_required",
  },
];

function fullResponse(overrides: Partial<Parameters<typeof evaluateHumanCandidateQualification>[1]> = {}) {
  return {
    candidateReference: "candidate-42",
    submittedAt: "2026-08-30T12:00:00.000Z",
    canMeetDeadline: true,
    availableForCorrections: true,
    communicationAcknowledged: true,
    compensationTermsAcknowledged: true,
    responses: [
      { requirementId: "browser_access", satisfied: true },
      {
        requirementId: "sample_evidence",
        satisfied: true,
        evidenceReference: "candidate-evidence:sample-1",
      },
    ],
    ...overrides,
  };
}

function qualifiedRecord() {
  const plan = buildHumanCandidateQualificationPlan(BASE_CONTRACT, REQUIREMENTS);
  return evaluateHumanCandidateQualification(plan, fullResponse());
}

test("candidate plan is candidate-specific and does not hire or enable payment", () => {
  const plan = buildHumanCandidateQualificationPlan(BASE_CONTRACT, REQUIREMENTS);
  assert.equal(plan.candidateReference, "candidate-42");
  assert.equal(plan.requirements.length, 2);
  assert.equal(plan.boundary.qualificationDoesNotHireWorker, true);
  assert.equal(plan.boundary.workerAcceptanceStillRequired, true);
  assert.equal(plan.boundary.paymentExecutionAllowed, false);
});

test("physical candidate qualification requires an explicit location check", () => {
  const physical: HumanFulfillmentContractDraft = { ...BASE_CONTRACT, kind: "physical" };
  assert.throws(
    () => buildHumanCandidateQualificationPlan(physical, REQUIREMENTS),
    /location requirement/,
  );
  assert.doesNotThrow(() =>
    buildHumanCandidateQualificationPlan(physical, [
      ...REQUIREMENTS,
      {
        id: "can_reach_site",
        category: "location",
        description: "Can reach the exact verified task location during the required window.",
        verification: "self_attestation",
      },
    ]),
  );
});

test("missing questionnaire answers or required evidence trigger follow-up instead of rejection", () => {
  const plan = buildHumanCandidateQualificationPlan(BASE_CONTRACT, REQUIREMENTS);
  const missingAnswer = evaluateHumanCandidateQualification(
    plan,
    fullResponse({ responses: [{ requirementId: "browser_access", satisfied: true }] }),
  );
  assert.equal(missingAnswer.status, "needs_followup");
  assert.deepEqual(missingAnswer.missingRequirementIds, ["sample_evidence"]);
  assert.equal(missingAnswer.boundary.assignmentAllowed, false);

  const missingEvidence = evaluateHumanCandidateQualification(
    plan,
    fullResponse({
      responses: [
        { requirementId: "browser_access", satisfied: true },
        { requirementId: "sample_evidence", satisfied: true },
      ],
    }),
  );
  assert.equal(missingEvidence.status, "needs_followup");
  assert.deepEqual(missingEvidence.missingEvidenceRequirementIds, ["sample_evidence"]);
});

test("explicit inability to satisfy a hard task condition is not qualified", () => {
  const plan = buildHumanCandidateQualificationPlan(BASE_CONTRACT, REQUIREMENTS);
  const failedRequirement = evaluateHumanCandidateQualification(
    plan,
    fullResponse({
      responses: [
        { requirementId: "browser_access", satisfied: false },
        {
          requirementId: "sample_evidence",
          satisfied: true,
          evidenceReference: "candidate-evidence:sample-1",
        },
      ],
    }),
  );
  assert.equal(failedRequirement.status, "not_qualified");
  assert.deepEqual(failedRequirement.failedRequirementIds, ["browser_access"]);

  const noCorrectionAvailability = evaluateHumanCandidateQualification(
    plan,
    fullResponse({ availableForCorrections: false }),
  );
  assert.equal(noCorrectionAvailability.status, "not_qualified");
  assert.match(noCorrectionAvailability.reasons.join(" "), /corrections/);
});

test("complete coherent response becomes qualified but still does not hire the worker", () => {
  const record = qualifiedRecord();
  assert.equal(record.status, "qualified");
  assert.equal(record.boundary.assignmentAllowed, true);
  assert.equal(record.boundary.workerHired, false);
  assert.equal(record.boundary.paymentExecutionAllowed, false);
  assert.deepEqual(record.missingRequirementIds, []);
  assert.deepEqual(record.failedRequirementIds, []);
});

test("assignment requires qualification, leaves an acceptance buffer, and starts as offered", () => {
  const qualification = qualifiedRecord();
  const assignment = createHumanFulfillmentAssignment(BASE_CONTRACT, qualification, {
    assignedAt: "2026-08-30T12:10:00.000Z",
    acceptBy: "2026-08-30T18:00:00.000Z",
  });
  assert.equal(assignment.status, "offered");
  assert.equal(assignment.candidateReference, "candidate-42");
  assert.equal(assignment.boundary.workerAcceptanceRequired, true);
  assert.equal(assignment.boundary.executionMayStart, false);
  assert.equal(assignment.boundary.paymentExecutionAllowed, false);

  assert.throws(
    () =>
      createHumanFulfillmentAssignment(BASE_CONTRACT, qualification, {
        assignedAt: "2026-08-31T19:00:00.000Z",
        acceptBy: "2026-08-31T20:00:00.000Z",
      }),
    /leave time before/,
  );
});

test("only an accepted assignment may start execution; decline/withdraw/expiry permit replacement", () => {
  const assignment = createHumanFulfillmentAssignment(BASE_CONTRACT, qualifiedRecord(), {
    assignedAt: "2026-08-30T12:10:00.000Z",
    acceptBy: "2026-08-30T18:00:00.000Z",
  });
  const accepted = recordHumanAssignmentDecision(assignment, {
    decision: "accepted",
    decidedAt: "2026-08-30T13:00:00.000Z",
  });
  assert.equal(accepted.boundary.executionMayStart, true);
  assert.equal(accepted.boundary.replacementAllowed, false);
  assert.equal(accepted.boundary.paymentExecutionAllowed, false);

  for (const decision of ["declined", "withdrawn", "expired"] as const) {
    const record = recordHumanAssignmentDecision(assignment, {
      decision,
      decidedAt: "2026-08-30T18:00:00.000Z",
      note: `${decision} test`,
    });
    assert.equal(record.boundary.executionMayStart, false);
    assert.equal(record.boundary.replacementAllowed, true);
  }
});

test("replacement assignment keeps an explicit pointer to the previous assignment", () => {
  const qualification = qualifiedRecord();
  const previous = createHumanFulfillmentAssignment(BASE_CONTRACT, qualification, {
    assignedAt: "2026-08-30T12:10:00.000Z",
    acceptBy: "2026-08-30T15:00:00.000Z",
  });
  const declined = recordHumanAssignmentDecision(previous, {
    decision: "declined",
    decidedAt: "2026-08-30T13:00:00.000Z",
  });
  assert.equal(declined.boundary.replacementAllowed, true);

  const replacement = createHumanFulfillmentAssignment(BASE_CONTRACT, qualification, {
    assignedAt: "2026-08-30T13:05:00.000Z",
    acceptBy: "2026-08-30T18:00:00.000Z",
    replacesAssignmentId: previous.assignmentId,
  });
  assert.equal(replacement.replacesAssignmentId, previous.assignmentId);
});

function review(outcome: HumanFulfillmentReviewRecord["outcome"]): HumanFulfillmentReviewRecord {
  const compensation = outcome === "accepted"
    ? { status: "full_due" as const, amountUsd: 30, rationale: "passed" }
    : outcome === "good_faith_failed"
      ? { status: "partial_due" as const, amountUsd: 8, rationale: "good faith" }
      : outcome === "suspicious"
        ? { status: "manual_review" as const, amountUsd: null, rationale: "unresolved" }
        : { status: "none" as const, amountUsd: 0, rationale: "failed review" };
  return {
    schemaVersion: 1,
    reviewId: `review_${outcome}`,
    contractId: BASE_CONTRACT.contractId,
    opportunityId: BASE_CONTRACT.opportunityId,
    reviewedAt: "2026-08-31T18:00:00.000Z",
    outcome,
    evidenceSummary: ["review evidence"],
    compensation,
    boundary: {
      paymentExecutionAllowed: false,
      explicitFinancialAuthorizationRequired: true,
    },
  };
}

function assignmentForPerformance() {
  return createHumanFulfillmentAssignment(BASE_CONTRACT, qualifiedRecord(), {
    assignedAt: "2026-08-30T12:10:00.000Z",
    acceptBy: "2026-08-30T18:00:00.000Z",
  });
}

test("performance record preserves nuanced future eligibility instead of treating every failure as fraud", () => {
  const assignment = assignmentForPerformance();
  const accepted = buildHumanWorkerPerformanceRecord(assignment, review("accepted"), {
    assignmentId: assignment.assignmentId,
    candidateReference: assignment.candidateReference,
    correctionsRequested: 1,
    correctionsCompleted: 1,
    communication: "good",
    onTime: true,
  });
  assert.equal(accepted.futureEligibility, "eligible");

  const goodFaith = buildHumanWorkerPerformanceRecord(assignment, review("good_faith_failed"), {
    assignmentId: assignment.assignmentId,
    candidateReference: assignment.candidateReference,
    correctionsRequested: 2,
    correctionsCompleted: 2,
    communication: "good",
    onTime: true,
  });
  assert.equal(goodFaith.futureEligibility, "case_by_case");

  const suspicious = buildHumanWorkerPerformanceRecord(assignment, review("suspicious"), {
    assignmentId: assignment.assignmentId,
    candidateReference: assignment.candidateReference,
    correctionsRequested: 1,
    correctionsCompleted: 0,
    communication: "mixed",
    onTime: false,
  });
  assert.equal(suspicious.futureEligibility, "hold_for_manual_review");
  assert.match(suspicious.reasons.join(" "), /unresolved/);

  for (const outcome of ["no_meaningful_effort", "established_fraud"] as const) {
    const record = buildHumanWorkerPerformanceRecord(assignment, review(outcome), {
      assignmentId: assignment.assignmentId,
      candidateReference: assignment.candidateReference,
      correctionsRequested: 1,
      correctionsCompleted: 0,
      communication: "poor",
      onTime: false,
    });
    assert.equal(record.futureEligibility, "do_not_reoffer");
  }
});
