import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanFulfillmentLifecycleEvent,
  HUMAN_FULFILLMENT_EVENT_TYPES,
} from "../src/opportunities/human-fulfillment-lifecycle.js";

test("candidate, assignment, attempt, correction, replacement and performance records have durable lifecycle event types", () => {
  for (const expected of [
    "candidate_qualification_recorded",
    "assignment_recorded",
    "assignment_decision_recorded",
    "attempt_submitted",
    "attempt_assessed",
    "correction_requested",
    "correction_response_recorded",
    "external_blocker_recorded",
    "replacement_authorized",
    "worker_performance_recorded",
  ] as const) {
    assert.ok(HUMAN_FULFILLMENT_EVENT_TYPES.includes(expected));
  }

  const qualification = createHumanFulfillmentLifecycleEvent({
    type: "candidate_qualification_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T12:00:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    qualificationId: "hqual_1",
    note: "qualified",
  });
  assert.equal(qualification.qualificationId, "hqual_1");
  assert.equal(qualification.candidateReference, "candidate-42");

  const assignment = createHumanFulfillmentLifecycleEvent({
    type: "assignment_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T12:10:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    qualificationId: "hqual_1",
    assignmentId: "hassign_1",
  });
  assert.equal(assignment.assignmentId, "hassign_1");

  const decision = createHumanFulfillmentLifecycleEvent({
    type: "assignment_decision_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T12:20:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    assignmentDecisionId: "hassigndec_1",
    note: "accepted",
  });
  assert.equal(decision.assignmentDecisionId, "hassigndec_1");

  const attempt = createHumanFulfillmentLifecycleEvent({
    type: "attempt_submitted",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T13:00:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    attemptId: "hattempt_1",
    evidenceSummary: ["worker submitted first evidence set"],
  });
  assert.equal(attempt.attemptId, "hattempt_1");

  const assessment = createHumanFulfillmentLifecycleEvent({
    type: "attempt_assessed",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T13:10:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    attemptId: "hattempt_1",
    assessmentId: "hassess_1",
    note: "correction_required",
  });
  assert.equal(assessment.assessmentId, "hassess_1");

  const correction = createHumanFulfillmentLifecycleEvent({
    type: "correction_requested",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T13:15:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    attemptId: "hattempt_1",
    assessmentId: "hassess_1",
    correctionRequestId: "hcorrect_1",
  });
  assert.equal(correction.correctionRequestId, "hcorrect_1");

  const correctionResponse = createHumanFulfillmentLifecycleEvent({
    type: "correction_response_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T14:00:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    correctionRequestId: "hcorrect_1",
    correctionResponseId: "hcorrectresp_1",
  });
  assert.equal(correctionResponse.correctionResponseId, "hcorrectresp_1");

  const blocker = createHumanFulfillmentLifecycleEvent({
    type: "external_blocker_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T14:10:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    attemptId: "hattempt_1",
    blockerId: "hblocker_1",
    note: "site access unavailable",
  });
  assert.equal(blocker.blockerId, "hblocker_1");

  const replacement = createHumanFulfillmentLifecycleEvent({
    type: "replacement_authorized",
    opportunityId: "opp_1",
    occurredAt: "2026-08-30T14:20:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    replacementAuthorizationId: "hreplace_1",
  });
  assert.equal(replacement.replacementAuthorizationId, "hreplace_1");

  const performance = createHumanFulfillmentLifecycleEvent({
    type: "worker_performance_recorded",
    opportunityId: "opp_1",
    occurredAt: "2026-08-31T18:00:00.000Z",
    contractId: "hcontract_1",
    candidateReference: "candidate-42",
    assignmentId: "hassign_1",
    reviewId: "review_1",
    performanceId: "hperf_1",
  });
  assert.equal(performance.performanceId, "hperf_1");
  assert.equal(performance.reviewId, "review_1");
});