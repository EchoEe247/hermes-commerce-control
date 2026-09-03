import { canonicalHash } from "../core/ids.js";
import type {
  HumanAssignmentDecisionRecord,
  HumanFulfillmentAssignment,
} from "./human-candidate-assignment.js";
import type {
  HumanFulfillmentContractDraft,
  HumanFulfillmentReviewRecord,
  HumanFulfillmentReviewOutcome,
} from "./human-fulfillment.js";

export interface HumanAttemptSubmission {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly attemptNumber: number;
  readonly submittedAt: string;
  readonly late: boolean;
  readonly evidenceSummary: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly note?: string | undefined;
  readonly boundary: {
    readonly submittedAgainstAcceptedAssignment: true;
    readonly contractTermsMutable: false;
    readonly paymentExecutionAllowed: false;
  };
}

export const HUMAN_ATTEMPT_ASSESSMENT_OUTCOMES = [
  "accepted",
  "correction_required",
  "worker_failed",
  "manual_review",
  "external_blocker",
] as const;
export type HumanAttemptAssessmentOutcome =
  (typeof HUMAN_ATTEMPT_ASSESSMENT_OUTCOMES)[number];

export type HumanExternalBlockerParty = "operator" | "upstream" | "site_access" | "other_external";

export interface HumanAttemptAssessmentInput {
  readonly outcome: HumanAttemptAssessmentOutcome;
  readonly assessedAt: string;
  readonly evidenceSummary: readonly string[];
  readonly deficiencies?: readonly string[] | undefined;
  readonly externalBlockerParty?: HumanExternalBlockerParty | undefined;
  readonly note?: string | undefined;
}

export interface HumanAttemptAssessment {
  readonly schemaVersion: 1;
  readonly assessmentId: string;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly attemptNumber: number;
  readonly outcome: HumanAttemptAssessmentOutcome;
  readonly assessedAt: string;
  readonly evidenceSummary: readonly string[];
  readonly deficiencies: readonly string[];
  readonly externalBlockerParty: HumanExternalBlockerParty | null;
  readonly recommendedReviewOutcome: HumanFulfillmentReviewOutcome | null;
  readonly boundary: {
    readonly correctionMayBeRequested: boolean;
    readonly replacementMayBeConsidered: boolean;
    readonly finalCompensationNotDecidedHere: true;
    readonly workerFaultEstablished: boolean;
    readonly paymentExecutionAllowed: false;
  };
}

export interface HumanCorrectionRequest {
  readonly schemaVersion: 1;
  readonly correctionRequestId: string;
  readonly assessmentId: string;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly correctionNumber: number;
  readonly maxCorrectionCycles: number;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly deficiencies: readonly string[];
  readonly frozenTermsHash: string;
  readonly boundary: {
    readonly newScopeAllowed: false;
    readonly compensationChangeAllowed: false;
    readonly paymentExecutionAllowed: false;
  };
}

export interface HumanCorrectionResponse {
  readonly schemaVersion: 1;
  readonly correctionResponseId: string;
  readonly correctionRequestId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly respondedAt: string;
  readonly late: boolean;
  readonly evidenceSummary: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly note?: string | undefined;
  readonly boundary: {
    readonly requiresFreshAssessment: true;
    readonly paymentExecutionAllowed: false;
  };
}

export interface HumanExternalBlockerRecord {
  readonly schemaVersion: 1;
  readonly blockerId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly attemptId: string | null;
  readonly party: HumanExternalBlockerParty;
  readonly recordedAt: string;
  readonly evidenceSummary: readonly string[];
  readonly goodFaithAttemptDocumented: boolean;
  readonly recommendedReviewOutcome: "good_faith_failed" | "suspicious";
  readonly boundary: {
    readonly workerFaultEstablished: false;
    readonly workerPerformancePenaltyAllowed: false;
    readonly paymentExecutionAllowed: false;
  };
}

export const HUMAN_REPLACEMENT_REASONS = [
  "assignment_declined",
  "assignment_withdrawn",
  "assignment_expired",
  "worker_cannot_continue",
  "correction_deadline_expired",
  "correction_cycles_exhausted",
  "no_meaningful_effort_established",
] as const;
export type HumanReplacementReason = (typeof HUMAN_REPLACEMENT_REASONS)[number];

export interface HumanReplacementAuthorizationInput {
  readonly reason: HumanReplacementReason;
  readonly authorizedAt: string;
  readonly evidenceSummary: readonly string[];
  readonly correctionRequest?: HumanCorrectionRequest | undefined;
  readonly finalReview?: HumanFulfillmentReviewRecord | undefined;
  readonly note?: string | undefined;
}

export interface HumanReplacementAuthorization {
  readonly schemaVersion: 1;
  readonly replacementAuthorizationId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly reason: HumanReplacementReason;
  readonly authorizedAt: string;
  readonly evidenceSummary: readonly string[];
  readonly note?: string | undefined;
  readonly boundary: {
    readonly replacementAllowed: true;
    readonly currentAssignmentExecutionMayContinue: false;
    readonly compensationOutcomeUnaffected: true;
    readonly paymentExecutionAllowed: false;
  };
}

function text(name: string, raw: string, max: number): string {
  const value = raw.trim();
  if (value === "") throw new Error(`${name} must not be empty`);
  if (value.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return value;
}

function timestamp(name: string, raw: string): string {
  const value = text(name, raw, 128);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid timestamp`);
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalNote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return text("note", raw, 2_000);
}

function uniqueText(
  name: string,
  values: readonly string[],
  maxItems = 64,
  maxChars = 2_000,
  requireOne = true,
): readonly string[] {
  if (values.length > maxItems) throw new Error(`${name} exceeds ${String(maxItems)} items`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = text(name, raw, maxChars);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  if (requireOne && out.length === 0) throw new Error(`${name} requires at least one item`);
  return Object.freeze(out);
}

function assertAssignmentIdentity(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
): void {
  if (assignment.contractId !== contract.contractId) throw new Error("assignment does not belong to contract");
  if (assignment.opportunityId !== contract.opportunityId) throw new Error("assignment does not belong to opportunity");
  if (assignment.candidateReference !== contract.terms.workerReference) {
    throw new Error("assignment candidate does not match contract worker reference");
  }
}

function assertAcceptedAssignment(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
  decision: HumanAssignmentDecisionRecord,
): void {
  assertAssignmentIdentity(contract, assignment);
  if (decision.assignmentId !== assignment.assignmentId) throw new Error("assignment decision does not match assignment");
  if (decision.contractId !== assignment.contractId || decision.opportunityId !== assignment.opportunityId) {
    throw new Error("assignment decision identity mismatch");
  }
  if (decision.candidateReference !== assignment.candidateReference) {
    throw new Error("assignment decision candidate mismatch");
  }
  if (decision.decision !== "accepted" || !decision.boundary.executionMayStart) {
    throw new Error("worker attempt requires an accepted assignment");
  }
}

function frozenTermsHash(contract: HumanFulfillmentContractDraft): string {
  return canonicalHash({
    contractId: contract.contractId,
    taskBrief: contract.terms.taskBrief,
    acceptanceCriteria: contract.terms.acceptanceCriteria,
    evidenceRequirements: contract.terms.evidenceRequirements,
    fullCompensationUsd: contract.terms.fullCompensationUsd,
    goodFaithAttemptCompensationUsd: contract.terms.goodFaithAttemptCompensationUsd,
    dueAt: contract.terms.dueAt ?? null,
  });
}

/** Record a worker submission only after they explicitly accepted the assignment. */
export function createHumanAttemptSubmission(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
  decision: HumanAssignmentDecisionRecord,
  input: {
    readonly attemptNumber: number;
    readonly submittedAt: string;
    readonly evidenceSummary: readonly string[];
    readonly evidenceReferences?: readonly string[] | undefined;
    readonly note?: string | undefined;
  },
): HumanAttemptSubmission {
  assertAcceptedAssignment(contract, assignment, decision);
  const attemptNumber = positiveInteger("attemptNumber", input.attemptNumber);
  const submittedAt = timestamp("submittedAt", input.submittedAt);
  if (Date.parse(submittedAt) < Date.parse(decision.decidedAt)) {
    throw new Error("attempt submission cannot predate worker acceptance");
  }
  const evidenceSummary = uniqueText("evidenceSummary", input.evidenceSummary);
  const evidenceReferences = uniqueText(
    "evidenceReferences",
    input.evidenceReferences ?? [],
    64,
    2_048,
    false,
  );
  const note = optionalNote(input.note);
  const late = contract.terms.dueAt !== undefined && Date.parse(submittedAt) > Date.parse(contract.terms.dueAt);
  const attemptId = `hattempt_${canonicalHash({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    contractId: contract.contractId,
    attemptNumber,
    submittedAt,
    evidenceSummary,
    evidenceReferences,
    note: note ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    attemptId,
    assignmentId: assignment.assignmentId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference: assignment.candidateReference,
    attemptNumber,
    submittedAt,
    late,
    evidenceSummary,
    evidenceReferences,
    ...(note === undefined ? {} : { note }),
    boundary: Object.freeze({
      submittedAgainstAcceptedAssignment: true as const,
      contractTermsMutable: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Assess one worker attempt without deciding compensation. A correction is only
 * available for a concrete fixable deficiency. Worker failure deliberately maps
 * to no automatic compensation outcome: the existing final review must decide
 * whether the evidence supports good-faith failure or no meaningful effort.
 */
export function assessHumanAttempt(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
  attempt: HumanAttemptSubmission,
  input: HumanAttemptAssessmentInput,
): HumanAttemptAssessment {
  assertAssignmentIdentity(contract, assignment);
  if (attempt.assignmentId !== assignment.assignmentId || attempt.contractId !== contract.contractId) {
    throw new Error("attempt does not belong to assignment/contract");
  }
  const assessedAt = timestamp("assessedAt", input.assessedAt);
  if (Date.parse(assessedAt) < Date.parse(attempt.submittedAt)) {
    throw new Error("attempt assessment cannot predate submission");
  }
  const evidenceSummary = uniqueText("evidenceSummary", input.evidenceSummary);
  const deficiencies = uniqueText(
    "deficiencies",
    input.deficiencies ?? [],
    32,
    2_000,
    input.outcome === "correction_required",
  );
  if (input.outcome === "accepted" && deficiencies.length > 0) {
    throw new Error("accepted attempt cannot carry unresolved deficiencies");
  }
  if (input.outcome === "external_blocker" && input.externalBlockerParty === undefined) {
    throw new Error("external_blocker assessment requires externalBlockerParty");
  }
  if (input.outcome !== "external_blocker" && input.externalBlockerParty !== undefined) {
    throw new Error("externalBlockerParty is only valid for external_blocker outcome");
  }
  const note = optionalNote(input.note);

  let recommendedReviewOutcome: HumanFulfillmentReviewOutcome | null;
  let correctionMayBeRequested = false;
  let replacementMayBeConsidered = false;
  let workerFaultEstablished = false;
  switch (input.outcome) {
    case "accepted":
      recommendedReviewOutcome = "accepted";
      break;
    case "correction_required":
      recommendedReviewOutcome = null;
      correctionMayBeRequested = true;
      break;
    case "worker_failed":
      recommendedReviewOutcome = null;
      replacementMayBeConsidered = true;
      workerFaultEstablished = true;
      break;
    case "manual_review":
      recommendedReviewOutcome = "suspicious";
      break;
    case "external_blocker":
      recommendedReviewOutcome = "good_faith_failed";
      break;
  }

  const assessmentId = `hassess_${canonicalHash({
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    outcome: input.outcome,
    assessedAt,
    evidenceSummary,
    deficiencies,
    externalBlockerParty: input.externalBlockerParty ?? null,
    note: note ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    assessmentId,
    attemptId: attempt.attemptId,
    assignmentId: assignment.assignmentId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference: assignment.candidateReference,
    attemptNumber: attempt.attemptNumber,
    outcome: input.outcome,
    assessedAt,
    evidenceSummary,
    deficiencies,
    externalBlockerParty: input.externalBlockerParty ?? null,
    recommendedReviewOutcome,
    boundary: Object.freeze({
      correctionMayBeRequested,
      replacementMayBeConsidered,
      finalCompensationNotDecidedHere: true as const,
      workerFaultEstablished,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Freeze a bounded correction request. It references the original contract and
 * terms hash; the request cannot change scope, acceptance criteria or either
 * compensation amount after execution has started.
 */
export function createHumanCorrectionRequest(
  contract: HumanFulfillmentContractDraft,
  assessment: HumanAttemptAssessment,
  input: {
    readonly correctionNumber: number;
    readonly maxCorrectionCycles: number;
    readonly requestedAt: string;
    readonly dueAt: string;
  },
): HumanCorrectionRequest {
  if (assessment.contractId !== contract.contractId || assessment.opportunityId !== contract.opportunityId) {
    throw new Error("assessment does not belong to contract/opportunity");
  }
  if (assessment.outcome !== "correction_required" || !assessment.boundary.correctionMayBeRequested) {
    throw new Error("correction request requires a correction_required assessment");
  }
  const correctionNumber = positiveInteger("correctionNumber", input.correctionNumber);
  const maxCorrectionCycles = positiveInteger("maxCorrectionCycles", input.maxCorrectionCycles);
  if (correctionNumber > maxCorrectionCycles) {
    throw new Error("correctionNumber cannot exceed maxCorrectionCycles");
  }
  const requestedAt = timestamp("requestedAt", input.requestedAt);
  const dueAt = timestamp("dueAt", input.dueAt);
  if (Date.parse(requestedAt) < Date.parse(assessment.assessedAt)) {
    throw new Error("correction request cannot predate assessment");
  }
  if (Date.parse(dueAt) <= Date.parse(requestedAt)) {
    throw new Error("correction dueAt must be after requestedAt");
  }
  if (contract.terms.dueAt !== undefined && Date.parse(dueAt) > Date.parse(contract.terms.dueAt)) {
    throw new Error("correction deadline cannot exceed the frozen task deadline");
  }
  const termsHash = frozenTermsHash(contract);
  const correctionRequestId = `hcorrect_${canonicalHash({
    schemaVersion: 1,
    assessmentId: assessment.assessmentId,
    correctionNumber,
    maxCorrectionCycles,
    requestedAt,
    dueAt,
    deficiencies: assessment.deficiencies,
    frozenTermsHash: termsHash,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    correctionRequestId,
    assessmentId: assessment.assessmentId,
    attemptId: assessment.attemptId,
    assignmentId: assessment.assignmentId,
    contractId: assessment.contractId,
    opportunityId: assessment.opportunityId,
    candidateReference: assessment.candidateReference,
    correctionNumber,
    maxCorrectionCycles,
    requestedAt,
    dueAt,
    deficiencies: assessment.deficiencies,
    frozenTermsHash: termsHash,
    boundary: Object.freeze({
      newScopeAllowed: false as const,
      compensationChangeAllowed: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

export function recordHumanCorrectionResponse(
  request: HumanCorrectionRequest,
  input: {
    readonly respondedAt: string;
    readonly evidenceSummary: readonly string[];
    readonly evidenceReferences?: readonly string[] | undefined;
    readonly note?: string | undefined;
  },
): HumanCorrectionResponse {
  const respondedAt = timestamp("respondedAt", input.respondedAt);
  if (Date.parse(respondedAt) < Date.parse(request.requestedAt)) {
    throw new Error("correction response cannot predate correction request");
  }
  const evidenceSummary = uniqueText("evidenceSummary", input.evidenceSummary);
  const evidenceReferences = uniqueText(
    "evidenceReferences",
    input.evidenceReferences ?? [],
    64,
    2_048,
    false,
  );
  const note = optionalNote(input.note);
  const late = Date.parse(respondedAt) > Date.parse(request.dueAt);
  const correctionResponseId = `hcorrectresp_${canonicalHash({
    schemaVersion: 1,
    correctionRequestId: request.correctionRequestId,
    respondedAt,
    evidenceSummary,
    evidenceReferences,
    note: note ?? null,
  }).slice(0, 32)}`;
  return Object.freeze({
    schemaVersion: 1 as const,
    correctionResponseId,
    correctionRequestId: request.correctionRequestId,
    assignmentId: request.assignmentId,
    contractId: request.contractId,
    opportunityId: request.opportunityId,
    candidateReference: request.candidateReference,
    respondedAt,
    late,
    evidenceSummary,
    evidenceReferences,
    ...(note === undefined ? {} : { note }),
    boundary: Object.freeze({
      requiresFreshAssessment: true as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Record a blocker caused by us, the upstream counterparty, or site/access
 * conditions. This explicitly prevents the event from being treated as worker
 * failure or a worker-performance penalty. If a documented good-faith attempt
 * exists, the existing contract's pre-agreed partial-compensation review is the
 * recommended path; otherwise the case remains manual/suspicious review.
 */
export function recordHumanExternalBlocker(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
  decision: HumanAssignmentDecisionRecord,
  input: {
    readonly party: HumanExternalBlockerParty;
    readonly recordedAt: string;
    readonly evidenceSummary: readonly string[];
    readonly goodFaithAttemptDocumented: boolean;
    readonly attempt?: HumanAttemptSubmission | undefined;
  },
): HumanExternalBlockerRecord {
  assertAcceptedAssignment(contract, assignment, decision);
  const recordedAt = timestamp("recordedAt", input.recordedAt);
  const evidenceSummary = uniqueText("evidenceSummary", input.evidenceSummary);
  if (input.attempt !== undefined) {
    if (input.attempt.assignmentId !== assignment.assignmentId || input.attempt.contractId !== contract.contractId) {
      throw new Error("external blocker attempt does not belong to assignment/contract");
    }
    if (Date.parse(recordedAt) < Date.parse(input.attempt.submittedAt)) {
      throw new Error("external blocker cannot predate referenced attempt");
    }
  }
  if (input.goodFaithAttemptDocumented && input.attempt === undefined) {
    throw new Error("documented good-faith attempt requires an attempt record");
  }
  const recommendedReviewOutcome = input.goodFaithAttemptDocumented
    ? "good_faith_failed" as const
    : "suspicious" as const;
  const blockerId = `hblocker_${canonicalHash({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    attemptId: input.attempt?.attemptId ?? null,
    party: input.party,
    recordedAt,
    evidenceSummary,
    goodFaithAttemptDocumented: input.goodFaithAttemptDocumented,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    blockerId,
    assignmentId: assignment.assignmentId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference: assignment.candidateReference,
    attemptId: input.attempt?.attemptId ?? null,
    party: input.party,
    recordedAt,
    evidenceSummary,
    goodFaithAttemptDocumented: input.goodFaithAttemptDocumented,
    recommendedReviewOutcome,
    boundary: Object.freeze({
      workerFaultEstablished: false as const,
      workerPerformancePenaltyAllowed: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Explicitly authorize replacement only from a supported terminal condition.
 * This record never changes the current worker's compensation outcome; that is
 * still determined by the frozen contract and final evidence-backed review.
 */
export function authorizeHumanReplacement(
  contract: HumanFulfillmentContractDraft,
  assignment: HumanFulfillmentAssignment,
  decision: HumanAssignmentDecisionRecord,
  input: HumanReplacementAuthorizationInput,
): HumanReplacementAuthorization {
  assertAssignmentIdentity(contract, assignment);
  if (decision.assignmentId !== assignment.assignmentId) throw new Error("assignment decision mismatch");
  const authorizedAt = timestamp("authorizedAt", input.authorizedAt);
  const evidenceSummary = uniqueText("evidenceSummary", input.evidenceSummary);
  const note = optionalNote(input.note);

  switch (input.reason) {
    case "assignment_declined":
      if (decision.decision !== "declined") throw new Error("assignment_declined requires declined decision");
      break;
    case "assignment_withdrawn":
      if (decision.decision !== "withdrawn") throw new Error("assignment_withdrawn requires withdrawn decision");
      break;
    case "assignment_expired":
      if (decision.decision !== "expired") throw new Error("assignment_expired requires expired decision");
      break;
    case "worker_cannot_continue":
      if (decision.decision !== "accepted") throw new Error("worker_cannot_continue requires accepted assignment");
      break;
    case "correction_deadline_expired": {
      if (decision.decision !== "accepted") throw new Error("correction deadline replacement requires accepted assignment");
      const correction = input.correctionRequest;
      if (correction === undefined) throw new Error("correction_deadline_expired requires correctionRequest");
      if (correction.assignmentId !== assignment.assignmentId) throw new Error("correctionRequest assignment mismatch");
      if (Date.parse(authorizedAt) <= Date.parse(correction.dueAt)) {
        throw new Error("correction deadline has not expired yet");
      }
      break;
    }
    case "correction_cycles_exhausted": {
      if (decision.decision !== "accepted") throw new Error("correction cycle replacement requires accepted assignment");
      const correction = input.correctionRequest;
      if (correction === undefined) throw new Error("correction_cycles_exhausted requires correctionRequest");
      if (correction.assignmentId !== assignment.assignmentId) throw new Error("correctionRequest assignment mismatch");
      if (correction.correctionNumber < correction.maxCorrectionCycles) {
        throw new Error("correction cycles are not exhausted");
      }
      break;
    }
    case "no_meaningful_effort_established": {
      const review = input.finalReview;
      if (review === undefined) throw new Error("no_meaningful_effort_established requires finalReview");
      if (review.contractId !== contract.contractId || review.opportunityId !== contract.opportunityId) {
        throw new Error("finalReview does not belong to contract/opportunity");
      }
      if (review.outcome !== "no_meaningful_effort") {
        throw new Error("replacement reason requires a no_meaningful_effort review");
      }
      break;
    }
  }

  if (Date.parse(authorizedAt) < Date.parse(decision.decidedAt)) {
    throw new Error("replacement authorization cannot predate assignment decision");
  }
  const replacementAuthorizationId = `hreplace_${canonicalHash({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    reason: input.reason,
    authorizedAt,
    evidenceSummary,
    correctionRequestId: input.correctionRequest?.correctionRequestId ?? null,
    finalReviewId: input.finalReview?.reviewId ?? null,
    note: note ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    replacementAuthorizationId,
    assignmentId: assignment.assignmentId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference: assignment.candidateReference,
    reason: input.reason,
    authorizedAt,
    evidenceSummary,
    ...(note === undefined ? {} : { note }),
    boundary: Object.freeze({
      replacementAllowed: true as const,
      currentAssignmentExecutionMayContinue: false as const,
      compensationOutcomeUnaffected: true as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}
