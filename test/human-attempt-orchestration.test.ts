import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanAssignmentDecisionRecord,
  HumanFulfillmentAssignment,
} from "../src/opportunities/human-candidate-assignment.js";
import type {
  HumanFulfillmentContractDraft,
  HumanFulfillmentReviewRecord,
} from "../src/opportunities/human-fulfillment.js";
import {
  assessHumanAttempt,
  authorizeHumanReplacement,
  createHumanAttemptSubmission,
  createHumanCorrectionRequest,
  recordHumanCorrectionResponse,
  recordHumanExternalBlocker,
} from "../src/opportunities/human-attempt-orchestration.js";

const CONTRACT: HumanFulfillmentContractDraft = {
  schemaVersion: 1,
  policyVersion: 1,
  contractId: "hcontract_attempt_test",
  recruitmentDraftId: "hrecruit_attempt_test",
  opportunityId: "opp_attempt_test",
  kind: "physical",
  terms: {
    workerReference: "worker-7",
    taskBrief: "Visit the verified location and capture the specified storefront evidence.",
    acceptanceCriteria: ["All six required photos are present", "Store hours are recorded"],
    evidenceRequirements: ["Six original photos", "Timestamped checklist"],
    fullCompensationUsd: 28,
    goodFaithAttemptCompensationUsd: 9,
    dueAt: "2026-08-31T18:00:00.000Z",
  },
  financial: {
    upstreamPayout: { minUsd: 70, maxUsd: null, basis: "observed" },
    grossMarginFloorUsd: 42,
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

const ASSIGNMENT: HumanFulfillmentAssignment = {
  schemaVersion: 1,
  assignmentId: "hassign_attempt_test",
  contractId: CONTRACT.contractId,
  opportunityId: CONTRACT.opportunityId,
  candidateReference: CONTRACT.terms.workerReference,
  qualificationId: "hqual_attempt_test",
  assignedAt: "2026-08-30T12:00:00.000Z",
  acceptBy: "2026-08-30T14:00:00.000Z",
  status: "offered",
  boundary: {
    workerAcceptanceRequired: true,
    executionMayStart: false,
    paymentExecutionAllowed: false,
  },
};

const ACCEPTED: HumanAssignmentDecisionRecord = {
  schemaVersion: 1,
  decisionId: "hassigndec_accepted",
  assignmentId: ASSIGNMENT.assignmentId,
  contractId: ASSIGNMENT.contractId,
  opportunityId: ASSIGNMENT.opportunityId,
  candidateReference: ASSIGNMENT.candidateReference,
  decidedAt: "2026-08-30T12:30:00.000Z",
  decision: "accepted",
  boundary: {
    executionMayStart: true,
    replacementAllowed: false,
    paymentExecutionAllowed: false,
  },
};

function decision(decision: "declined" | "withdrawn" | "expired"): HumanAssignmentDecisionRecord {
  return {
    schemaVersion: 1,
    decisionId: `hassigndec_${decision}`,
    assignmentId: ASSIGNMENT.assignmentId,
    contractId: ASSIGNMENT.contractId,
    opportunityId: ASSIGNMENT.opportunityId,
    candidateReference: ASSIGNMENT.candidateReference,
    decidedAt: "2026-08-30T13:00:00.000Z",
    decision,
    boundary: {
      executionMayStart: false,
      replacementAllowed: true,
      paymentExecutionAllowed: false,
    },
  };
}

function firstAttempt() {
  return createHumanAttemptSubmission(CONTRACT, ASSIGNMENT, ACCEPTED, {
    attemptNumber: 1,
    submittedAt: "2026-08-30T15:00:00.000Z",
    evidenceSummary: ["Worker submitted storefront photos and checklist."],
    evidenceReferences: ["evidence://attempt-1"],
  });
}

function correctionAssessment() {
  return assessHumanAttempt(CONTRACT, ASSIGNMENT, firstAttempt(), {
    outcome: "correction_required",
    assessedAt: "2026-08-30T15:10:00.000Z",
    evidenceSummary: ["Five of six required photos are present."],
    deficiencies: ["Missing the required hours-sign photo."],
  });
}

test("worker submission requires an explicitly accepted assignment", () => {
  const declined = decision("declined");
  assert.throws(
    () =>
      createHumanAttemptSubmission(CONTRACT, ASSIGNMENT, declined, {
        attemptNumber: 1,
        submittedAt: "2026-08-30T15:00:00.000Z",
        evidenceSummary: ["should not be accepted"],
      }),
    /accepted assignment/,
  );

  const attempt = firstAttempt();
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.boundary.submittedAgainstAcceptedAssignment, true);
  assert.equal(attempt.boundary.contractTermsMutable, false);
  assert.equal(attempt.boundary.paymentExecutionAllowed, false);
});

test("fixable attempt produces a bounded correction request without scope or pay changes", () => {
  const assessment = correctionAssessment();
  assert.equal(assessment.outcome, "correction_required");
  assert.equal(assessment.boundary.correctionMayBeRequested, true);
  assert.equal(assessment.recommendedReviewOutcome, null);

  const request = createHumanCorrectionRequest(CONTRACT, assessment, {
    correctionNumber: 1,
    maxCorrectionCycles: 2,
    requestedAt: "2026-08-30T15:15:00.000Z",
    dueAt: "2026-08-30T18:00:00.000Z",
  });
  assert.deepEqual(request.deficiencies, ["Missing the required hours-sign photo."]);
  assert.match(request.frozenTermsHash, /^[0-9a-f]{64}$/);
  assert.equal(request.boundary.newScopeAllowed, false);
  assert.equal(request.boundary.compensationChangeAllowed, false);
  assert.equal(CONTRACT.terms.fullCompensationUsd, 28);
  assert.equal(CONTRACT.terms.goodFaithAttemptCompensationUsd, 9);

  assert.throws(
    () =>
      createHumanCorrectionRequest(CONTRACT, assessment, {
        correctionNumber: 1,
        maxCorrectionCycles: 2,
        requestedAt: "2026-08-31T17:00:00.000Z",
        dueAt: "2026-08-31T19:00:00.000Z",
      }),
    /cannot exceed the frozen task deadline/,
  );
});

test("correction response requires fresh assessment and a corrected second attempt can pass", () => {
  const request = createHumanCorrectionRequest(CONTRACT, correctionAssessment(), {
    correctionNumber: 1,
    maxCorrectionCycles: 2,
    requestedAt: "2026-08-30T15:15:00.000Z",
    dueAt: "2026-08-30T18:00:00.000Z",
  });
  const response = recordHumanCorrectionResponse(request, {
    respondedAt: "2026-08-30T16:00:00.000Z",
    evidenceSummary: ["Added the missing hours-sign photo."],
    evidenceReferences: ["evidence://correction-1"],
  });
  assert.equal(response.late, false);
  assert.equal(response.boundary.requiresFreshAssessment, true);

  const correctedAttempt = createHumanAttemptSubmission(CONTRACT, ASSIGNMENT, ACCEPTED, {
    attemptNumber: 2,
    submittedAt: response.respondedAt,
    evidenceSummary: ["Complete corrected photo set and checklist submitted."],
    evidenceReferences: ["evidence://attempt-2"],
  });
  const accepted = assessHumanAttempt(CONTRACT, ASSIGNMENT, correctedAttempt, {
    outcome: "accepted",
    assessedAt: "2026-08-30T16:10:00.000Z",
    evidenceSummary: ["All frozen acceptance criteria now pass."],
  });
  assert.equal(accepted.recommendedReviewOutcome, "accepted");
  assert.equal(accepted.boundary.replacementMayBeConsidered, false);
  assert.equal(accepted.boundary.finalCompensationNotDecidedHere, true);
});

test("worker_failed does not automatically become zero-pay or fraud", () => {
  const failed = assessHumanAttempt(CONTRACT, ASSIGNMENT, firstAttempt(), {
    outcome: "worker_failed",
    assessedAt: "2026-08-30T15:10:00.000Z",
    evidenceSummary: ["Worker states they cannot finish the remaining requirements."],
  });
  assert.equal(failed.boundary.workerFaultEstablished, true);
  assert.equal(failed.boundary.replacementMayBeConsidered, true);
  assert.equal(failed.recommendedReviewOutcome, null, "final evidence-backed review must decide compensation");
  assert.equal(failed.boundary.finalCompensationNotDecidedHere, true);
});

test("suspicious attempt stays in manual review rather than automatic no-pay", () => {
  const suspicious = assessHumanAttempt(CONTRACT, ASSIGNMENT, firstAttempt(), {
    outcome: "manual_review",
    assessedAt: "2026-08-30T15:10:00.000Z",
    evidenceSummary: ["Photo metadata conflicts with expected timeline and needs review."],
  });
  assert.equal(suspicious.recommendedReviewOutcome, "suspicious");
  assert.equal(suspicious.boundary.workerFaultEstablished, false);
  assert.equal(suspicious.boundary.replacementMayBeConsidered, false);
});

test("operator/upstream/site blocker explicitly protects worker from automatic fault/performance penalty", () => {
  const attempt = firstAttempt();
  const blocker = recordHumanExternalBlocker(CONTRACT, ASSIGNMENT, ACCEPTED, {
    party: "site_access",
    recordedAt: "2026-08-30T15:20:00.000Z",
    evidenceSummary: ["Worker arrived but the verified site was unexpectedly inaccessible."],
    goodFaithAttemptDocumented: true,
    attempt,
  });
  assert.equal(blocker.goodFaithAttemptDocumented, true);
  assert.equal(blocker.recommendedReviewOutcome, "good_faith_failed");
  assert.equal(blocker.boundary.workerFaultEstablished, false);
  assert.equal(blocker.boundary.workerPerformancePenaltyAllowed, false);
  assert.equal(blocker.boundary.paymentExecutionAllowed, false);

  assert.throws(
    () =>
      recordHumanExternalBlocker(CONTRACT, ASSIGNMENT, ACCEPTED, {
        party: "operator",
        recordedAt: "2026-08-30T15:20:00.000Z",
        evidenceSummary: ["Operator supplied wrong location."],
        goodFaithAttemptDocumented: true,
      }),
    /requires an attempt record/,
  );
});

test("declined withdrawn or expired assignment can be explicitly replaced", () => {
  for (const [assignmentDecision, reason] of [
    ["declined", "assignment_declined"],
    ["withdrawn", "assignment_withdrawn"],
    ["expired", "assignment_expired"],
  ] as const) {
    const replacement = authorizeHumanReplacement(CONTRACT, ASSIGNMENT, decision(assignmentDecision), {
      reason,
      authorizedAt: "2026-08-30T14:00:00.000Z",
      evidenceSummary: [`Assignment ${assignmentDecision}.`],
    });
    assert.equal(replacement.boundary.replacementAllowed, true);
    assert.equal(replacement.boundary.compensationOutcomeUnaffected, true);
  }
});

test("correction deadline or exhausted cycles can authorize replacement only when the condition is actually met", () => {
  const request = createHumanCorrectionRequest(CONTRACT, correctionAssessment(), {
    correctionNumber: 2,
    maxCorrectionCycles: 2,
    requestedAt: "2026-08-30T15:15:00.000Z",
    dueAt: "2026-08-30T18:00:00.000Z",
  });

  assert.throws(
    () =>
      authorizeHumanReplacement(CONTRACT, ASSIGNMENT, ACCEPTED, {
        reason: "correction_deadline_expired",
        authorizedAt: "2026-08-30T17:59:00.000Z",
        evidenceSummary: ["too early"],
        correctionRequest: request,
      }),
    /has not expired/,
  );

  const deadline = authorizeHumanReplacement(CONTRACT, ASSIGNMENT, ACCEPTED, {
    reason: "correction_deadline_expired",
    authorizedAt: "2026-08-30T18:01:00.000Z",
    evidenceSummary: ["Correction deadline expired without response."],
    correctionRequest: request,
  });
  assert.equal(deadline.reason, "correction_deadline_expired");

  const exhausted = authorizeHumanReplacement(CONTRACT, ASSIGNMENT, ACCEPTED, {
    reason: "correction_cycles_exhausted",
    authorizedAt: "2026-08-30T18:01:00.000Z",
    evidenceSummary: ["Maximum pre-set correction cycles exhausted."],
    correctionRequest: request,
  });
  assert.equal(exhausted.reason, "correction_cycles_exhausted");
});

function review(outcome: HumanFulfillmentReviewRecord["outcome"]): HumanFulfillmentReviewRecord {
  return {
    schemaVersion: 1,
    reviewId: `hreview_${outcome}`,
    contractId: CONTRACT.contractId,
    opportunityId: CONTRACT.opportunityId,
    reviewedAt: "2026-08-30T17:00:00.000Z",
    outcome,
    evidenceSummary: ["final review evidence"],
    compensation: outcome === "no_meaningful_effort"
      ? { status: "none", amountUsd: 0, rationale: "no meaningful effort established" }
      : { status: "manual_review", amountUsd: null, rationale: "manual" },
    boundary: {
      paymentExecutionAllowed: false,
      explicitFinancialAuthorizationRequired: true,
    },
  };
}

test("no-meaningful-effort replacement requires that exact final review finding", () => {
  assert.throws(
    () =>
      authorizeHumanReplacement(CONTRACT, ASSIGNMENT, ACCEPTED, {
        reason: "no_meaningful_effort_established",
        authorizedAt: "2026-08-30T17:10:00.000Z",
        evidenceSummary: ["not enough"],
        finalReview: review("suspicious"),
      }),
    /requires a no_meaningful_effort review/,
  );

  const replacement = authorizeHumanReplacement(CONTRACT, ASSIGNMENT, ACCEPTED, {
    reason: "no_meaningful_effort_established",
    authorizedAt: "2026-08-30T17:10:00.000Z",
    evidenceSummary: ["Final review established no meaningful performance."],
    finalReview: review("no_meaningful_effort"),
  });
  assert.equal(replacement.boundary.replacementAllowed, true);
  assert.equal(replacement.boundary.paymentExecutionAllowed, false);
});
