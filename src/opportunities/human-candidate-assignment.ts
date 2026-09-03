import { canonicalHash } from "../core/ids.js";
import type {
  HumanFulfillmentContractDraft,
  HumanFulfillmentReviewRecord,
} from "./human-fulfillment.js";

export const HUMAN_CANDIDATE_REQUIREMENT_CATEGORIES = [
  "capability",
  "equipment",
  "credential",
  "location",
  "schedule",
  "other",
] as const;
export type HumanCandidateRequirementCategory =
  (typeof HUMAN_CANDIDATE_REQUIREMENT_CATEGORIES)[number];

export type HumanCandidateRequirementVerification = "self_attestation" | "evidence_required";

export interface HumanCandidateRequirement {
  readonly id: string;
  readonly category: HumanCandidateRequirementCategory;
  readonly description: string;
  readonly verification: HumanCandidateRequirementVerification;
}

export interface HumanCandidateQualificationPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly kind: HumanFulfillmentContractDraft["kind"];
  readonly dueAt: string | null;
  readonly requirements: readonly HumanCandidateRequirement[];
  readonly standardChecks: {
    readonly canMeetDeadline: true;
    readonly availableForCorrections: true;
    readonly communicationAcknowledged: true;
    readonly compensationTermsAcknowledged: true;
  };
  readonly boundary: {
    readonly qualificationDoesNotHireWorker: true;
    readonly workerAcceptanceStillRequired: true;
    readonly paymentExecutionAllowed: false;
  };
}

export interface HumanCandidateRequirementResponse {
  readonly requirementId: string;
  readonly satisfied: boolean;
  readonly evidenceReference?: string | undefined;
  readonly note?: string | undefined;
}

export interface HumanCandidateQualificationResponse {
  readonly candidateReference: string;
  readonly submittedAt: string;
  readonly canMeetDeadline: boolean;
  readonly availableForCorrections: boolean;
  readonly communicationAcknowledged: boolean;
  readonly compensationTermsAcknowledged: boolean;
  readonly responses: readonly HumanCandidateRequirementResponse[];
}

export type HumanCandidateQualificationStatus =
  | "qualified"
  | "needs_followup"
  | "not_qualified";

export interface HumanCandidateQualificationRecord {
  readonly schemaVersion: 1;
  readonly qualificationId: string;
  readonly planId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly submittedAt: string;
  readonly status: HumanCandidateQualificationStatus;
  readonly satisfiedRequirementIds: readonly string[];
  readonly missingRequirementIds: readonly string[];
  readonly failedRequirementIds: readonly string[];
  readonly missingEvidenceRequirementIds: readonly string[];
  readonly reasons: readonly string[];
  readonly boundary: {
    readonly assignmentAllowed: boolean;
    readonly workerHired: false;
    readonly paymentExecutionAllowed: false;
  };
}

export interface HumanFulfillmentAssignment {
  readonly schemaVersion: 1;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly qualificationId: string;
  readonly assignedAt: string;
  readonly acceptBy: string;
  readonly replacesAssignmentId?: string | undefined;
  readonly status: "offered";
  readonly boundary: {
    readonly workerAcceptanceRequired: true;
    readonly executionMayStart: false;
    readonly paymentExecutionAllowed: false;
  };
}

export type HumanAssignmentDecision = "accepted" | "declined" | "withdrawn" | "expired";

export interface HumanAssignmentDecisionRecord {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly decidedAt: string;
  readonly decision: HumanAssignmentDecision;
  readonly note?: string | undefined;
  readonly boundary: {
    readonly executionMayStart: boolean;
    readonly replacementAllowed: boolean;
    readonly paymentExecutionAllowed: false;
  };
}

export type HumanWorkerFutureEligibility =
  | "eligible"
  | "case_by_case"
  | "hold_for_manual_review"
  | "do_not_reoffer";

export interface HumanWorkerPerformanceInput {
  readonly assignmentId: string;
  readonly candidateReference: string;
  readonly correctionsRequested: number;
  readonly correctionsCompleted: number;
  readonly communication: "good" | "mixed" | "poor";
  readonly onTime: boolean;
  readonly note?: string | undefined;
}

export interface HumanWorkerPerformanceRecord {
  readonly schemaVersion: 1;
  readonly performanceId: string;
  readonly assignmentId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly candidateReference: string;
  readonly reviewId: string;
  readonly reviewOutcome: HumanFulfillmentReviewRecord["outcome"];
  readonly correctionsRequested: number;
  readonly correctionsCompleted: number;
  readonly communication: HumanWorkerPerformanceInput["communication"];
  readonly onTime: boolean;
  readonly futureEligibility: HumanWorkerFutureEligibility;
  readonly reasons: readonly string[];
  readonly note?: string | undefined;
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

function optionalNote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return text("note", raw, 2_000);
}

function dedupeRequirements(
  requirements: readonly HumanCandidateRequirement[],
): readonly HumanCandidateRequirement[] {
  if (requirements.length === 0) throw new Error("at least one candidate requirement is required");
  if (requirements.length > 32) throw new Error("candidate requirements exceed 32 items");
  const ids = new Set<string>();
  const normalized = requirements.map((requirement) => {
    const id = text("requirement id", requirement.id, 128);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      throw new Error(`invalid requirement id ${JSON.stringify(id)}`);
    }
    if (ids.has(id)) throw new Error(`duplicate requirement id ${id}`);
    ids.add(id);
    return Object.freeze({
      id,
      category: requirement.category,
      description: text("requirement description", requirement.description, 2_000),
      verification: requirement.verification,
    });
  });
  return Object.freeze(normalized);
}

/**
 * Build the candidate-specific questionnaire/checklist before assignment.
 * Physical work must explicitly include a location requirement so the system
 * cannot mark a worker qualified without confirming they can reach the task.
 */
export function buildHumanCandidateQualificationPlan(
  contract: HumanFulfillmentContractDraft,
  requirements: readonly HumanCandidateRequirement[],
): HumanCandidateQualificationPlan {
  if (!contract.financial.paymentAuthorizationReady) {
    throw new Error("candidate qualification requires a financially viable worker contract");
  }
  const normalized = dedupeRequirements(requirements);
  if (contract.kind === "physical" && !normalized.some((item) => item.category === "location")) {
    throw new Error("physical candidate qualification requires an explicit location requirement");
  }
  const candidateReference = text("workerReference", contract.terms.workerReference, 512);
  const dueAt = contract.terms.dueAt ?? null;
  const planId = `hqualplan_${canonicalHash({
    schemaVersion: 1,
    contractId: contract.contractId,
    candidateReference,
    dueAt,
    requirements: normalized,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    planId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference,
    kind: contract.kind,
    dueAt,
    requirements: normalized,
    standardChecks: Object.freeze({
      canMeetDeadline: true as const,
      availableForCorrections: true as const,
      communicationAcknowledged: true as const,
      compensationTermsAcknowledged: true as const,
    }),
    boundary: Object.freeze({
      qualificationDoesNotHireWorker: true as const,
      workerAcceptanceStillRequired: true as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

function normalizeResponses(
  responses: readonly HumanCandidateRequirementResponse[],
): ReadonlyMap<string, HumanCandidateRequirementResponse> {
  if (responses.length > 64) throw new Error("candidate responses exceed 64 items");
  const out = new Map<string, HumanCandidateRequirementResponse>();
  for (const raw of responses) {
    const requirementId = text("requirementId", raw.requirementId, 128);
    if (out.has(requirementId)) throw new Error(`duplicate candidate response for ${requirementId}`);
    const evidenceReference = raw.evidenceReference === undefined
      ? undefined
      : text("evidenceReference", raw.evidenceReference, 2_048);
    const note = optionalNote(raw.note);
    out.set(
      requirementId,
      Object.freeze({
        requirementId,
        satisfied: raw.satisfied,
        ...(evidenceReference === undefined ? {} : { evidenceReference }),
        ...(note === undefined ? {} : { note }),
      }),
    );
  }
  return out;
}

/**
 * Deterministically classify the questionnaire response.
 * Missing answers/evidence mean follow-up, while an explicit failure of a hard
 * requirement means the candidate is not qualified for this task.
 */
export function evaluateHumanCandidateQualification(
  plan: HumanCandidateQualificationPlan,
  response: HumanCandidateQualificationResponse,
): HumanCandidateQualificationRecord {
  const candidateReference = text("candidateReference", response.candidateReference, 512);
  if (candidateReference !== plan.candidateReference) {
    throw new Error("candidate response does not match qualification plan worker reference");
  }
  const submittedAt = timestamp("submittedAt", response.submittedAt);
  const byId = normalizeResponses(response.responses);
  const knownIds = new Set(plan.requirements.map((item) => item.id));
  for (const id of byId.keys()) {
    if (!knownIds.has(id)) throw new Error(`candidate response references unknown requirement ${id}`);
  }

  const satisfied: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  const missingEvidence: string[] = [];
  const reasons: string[] = [];

  for (const requirement of plan.requirements) {
    const answer = byId.get(requirement.id);
    if (answer === undefined) {
      missing.push(requirement.id);
      continue;
    }
    if (!answer.satisfied) {
      failed.push(requirement.id);
      continue;
    }
    if (requirement.verification === "evidence_required" && answer.evidenceReference === undefined) {
      missingEvidence.push(requirement.id);
      continue;
    }
    satisfied.push(requirement.id);
  }

  if (!response.canMeetDeadline) reasons.push("candidate cannot meet the required deadline");
  if (!response.availableForCorrections) reasons.push("candidate is not available for required corrections/follow-up");
  if (!response.communicationAcknowledged) reasons.push("candidate did not acknowledge communication/follow-up expectations");
  if (!response.compensationTermsAcknowledged) reasons.push("candidate did not acknowledge compensation terms");
  if (plan.dueAt !== null && Date.parse(submittedAt) >= Date.parse(plan.dueAt)) {
    reasons.push("candidate response arrived at or after the task deadline");
  }

  const explicitFailure =
    failed.length > 0 ||
    reasons.length > 0;
  const incomplete = missing.length > 0 || missingEvidence.length > 0;
  const status: HumanCandidateQualificationStatus = explicitFailure
    ? "not_qualified"
    : incomplete
      ? "needs_followup"
      : "qualified";

  if (missing.length > 0) reasons.push(`missing required answers: ${missing.join(", ")}`);
  if (missingEvidence.length > 0) {
    reasons.push(`missing required qualification evidence: ${missingEvidence.join(", ")}`);
  }
  if (failed.length > 0) reasons.push(`failed task requirements: ${failed.join(", ")}`);

  const qualificationId = `hqual_${canonicalHash({
    schemaVersion: 1,
    planId: plan.planId,
    candidateReference,
    submittedAt,
    status,
    satisfied,
    missing,
    failed,
    missingEvidence,
    reasons,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    qualificationId,
    planId: plan.planId,
    contractId: plan.contractId,
    opportunityId: plan.opportunityId,
    candidateReference,
    submittedAt,
    status,
    satisfiedRequirementIds: Object.freeze(satisfied),
    missingRequirementIds: Object.freeze(missing),
    failedRequirementIds: Object.freeze(failed),
    missingEvidenceRequirementIds: Object.freeze(missingEvidence),
    reasons: Object.freeze(reasons),
    boundary: Object.freeze({
      assignmentAllowed: status === "qualified",
      workerHired: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

export function createHumanFulfillmentAssignment(
  contract: HumanFulfillmentContractDraft,
  qualification: HumanCandidateQualificationRecord,
  input: {
    readonly assignedAt: string;
    readonly acceptBy: string;
    readonly replacesAssignmentId?: string | undefined;
  },
): HumanFulfillmentAssignment {
  if (qualification.contractId !== contract.contractId) {
    throw new Error("qualification does not belong to contract");
  }
  if (qualification.opportunityId !== contract.opportunityId) {
    throw new Error("qualification does not belong to opportunity");
  }
  if (qualification.candidateReference !== contract.terms.workerReference) {
    throw new Error("qualified candidate does not match contract worker reference");
  }
  if (qualification.status !== "qualified" || !qualification.boundary.assignmentAllowed) {
    throw new Error("only a qualified candidate may receive an assignment");
  }
  if (!contract.financial.paymentAuthorizationReady) {
    throw new Error("assignment requires a financially viable worker contract");
  }
  const assignedAt = timestamp("assignedAt", input.assignedAt);
  const acceptBy = timestamp("acceptBy", input.acceptBy);
  if (Date.parse(acceptBy) <= Date.parse(assignedAt)) {
    throw new Error("acceptBy must be after assignedAt");
  }
  if (contract.terms.dueAt !== undefined && Date.parse(acceptBy) >= Date.parse(contract.terms.dueAt)) {
    throw new Error("acceptBy must leave time before the task deadline");
  }
  const replacesAssignmentId = input.replacesAssignmentId === undefined
    ? undefined
    : text("replacesAssignmentId", input.replacesAssignmentId, 128);
  const assignmentId = `hassign_${canonicalHash({
    schemaVersion: 1,
    contractId: contract.contractId,
    qualificationId: qualification.qualificationId,
    candidateReference: qualification.candidateReference,
    assignedAt,
    acceptBy,
    replacesAssignmentId: replacesAssignmentId ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    assignmentId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    candidateReference: qualification.candidateReference,
    qualificationId: qualification.qualificationId,
    assignedAt,
    acceptBy,
    ...(replacesAssignmentId === undefined ? {} : { replacesAssignmentId }),
    status: "offered" as const,
    boundary: Object.freeze({
      workerAcceptanceRequired: true as const,
      executionMayStart: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

export function recordHumanAssignmentDecision(
  assignment: HumanFulfillmentAssignment,
  input: {
    readonly decision: HumanAssignmentDecision;
    readonly decidedAt: string;
    readonly note?: string | undefined;
  },
): HumanAssignmentDecisionRecord {
  const decidedAt = timestamp("decidedAt", input.decidedAt);
  if (Date.parse(decidedAt) < Date.parse(assignment.assignedAt)) {
    throw new Error("assignment decision cannot predate the assignment");
  }
  if (input.decision === "accepted" && Date.parse(decidedAt) > Date.parse(assignment.acceptBy)) {
    throw new Error("assignment cannot be accepted after its acceptance deadline");
  }
  const note = optionalNote(input.note);
  const decisionId = `hassigndec_${canonicalHash({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    decision: input.decision,
    decidedAt,
    note: note ?? null,
  }).slice(0, 32)}`;
  const executionMayStart = input.decision === "accepted";
  const replacementAllowed = input.decision !== "accepted";

  return Object.freeze({
    schemaVersion: 1 as const,
    decisionId,
    assignmentId: assignment.assignmentId,
    contractId: assignment.contractId,
    opportunityId: assignment.opportunityId,
    candidateReference: assignment.candidateReference,
    decidedAt,
    decision: input.decision,
    ...(note === undefined ? {} : { note }),
    boundary: Object.freeze({
      executionMayStart,
      replacementAllowed,
      paymentExecutionAllowed: false as const,
    }),
  });
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Turn final QA evidence into a private future-eligibility note. Suspicion is
 * intentionally a hold for manual review, not a permanent ban or fraud finding.
 */
export function buildHumanWorkerPerformanceRecord(
  assignment: HumanFulfillmentAssignment,
  review: HumanFulfillmentReviewRecord,
  input: HumanWorkerPerformanceInput,
): HumanWorkerPerformanceRecord {
  if (review.contractId !== assignment.contractId || review.opportunityId !== assignment.opportunityId) {
    throw new Error("review does not belong to assignment contract/opportunity");
  }
  if (input.assignmentId !== assignment.assignmentId) throw new Error("performance input assignmentId mismatch");
  if (input.candidateReference !== assignment.candidateReference) {
    throw new Error("performance input candidateReference mismatch");
  }
  const correctionsRequested = nonNegativeInteger("correctionsRequested", input.correctionsRequested);
  const correctionsCompleted = nonNegativeInteger("correctionsCompleted", input.correctionsCompleted);
  if (correctionsCompleted > correctionsRequested) {
    throw new Error("correctionsCompleted cannot exceed correctionsRequested");
  }
  const note = optionalNote(input.note);
  const reasons: string[] = [];
  let futureEligibility: HumanWorkerFutureEligibility;

  switch (review.outcome) {
    case "accepted":
      futureEligibility = input.communication === "poor" || !input.onTime ? "case_by_case" : "eligible";
      reasons.push("deliverable passed acceptance criteria");
      break;
    case "good_faith_failed":
      futureEligibility = "case_by_case";
      reasons.push("good-faith attempt did not pass final acceptance");
      break;
    case "no_meaningful_effort":
      futureEligibility = "do_not_reoffer";
      reasons.push("review established no meaningful contract performance");
      break;
    case "established_fraud":
      futureEligibility = "do_not_reoffer";
      reasons.push("review established fraud");
      break;
    case "suspicious":
      futureEligibility = "hold_for_manual_review";
      reasons.push("review remains suspicious and unresolved; no permanent finding is inferred");
      break;
  }

  if (correctionsRequested > correctionsCompleted) {
    reasons.push(`${String(correctionsRequested - correctionsCompleted)} requested correction(s) were not completed`);
    if (futureEligibility === "eligible") futureEligibility = "case_by_case";
  }
  if (input.communication === "poor") reasons.push("communication was poor during execution/follow-up");
  if (!input.onTime) reasons.push("task or follow-up was not completed on time");

  const performanceId = `hperf_${canonicalHash({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    reviewId: review.reviewId,
    candidateReference: assignment.candidateReference,
    correctionsRequested,
    correctionsCompleted,
    communication: input.communication,
    onTime: input.onTime,
    futureEligibility,
    reasons,
    note: note ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    performanceId,
    assignmentId: assignment.assignmentId,
    contractId: assignment.contractId,
    opportunityId: assignment.opportunityId,
    candidateReference: assignment.candidateReference,
    reviewId: review.reviewId,
    reviewOutcome: review.outcome,
    correctionsRequested,
    correctionsCompleted,
    communication: input.communication,
    onTime: input.onTime,
    futureEligibility,
    reasons: Object.freeze(reasons),
    ...(note === undefined ? {} : { note }),
  });
}
