import { canonicalHash } from "../core/ids.js";
import type { OpportunityExecutionPlan } from "./execution-routing.js";
import type { RankedOpportunity } from "./ranking.js";

export const HUMAN_FULFILLMENT_POLICY_VERSION = 1 as const;

export const HUMAN_RECRUITMENT_CHANNELS = ["reddit", "marketplace", "direct", "other"] as const;
export type HumanRecruitmentChannel = (typeof HUMAN_RECRUITMENT_CHANNELS)[number];

export const HUMAN_RECRUITMENT_REQUIRED_INPUTS = [
  "exact_task_scope",
  "acceptance_criteria",
  "timeline",
  "worker_identity",
  "agreed_compensation",
  "platform_rules_check",
] as const;
export type HumanRecruitmentRequiredInput = (typeof HUMAN_RECRUITMENT_REQUIRED_INPUTS)[number];

export interface HumanRecruitmentDraft {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof HUMAN_FULFILLMENT_POLICY_VERSION;
  readonly draftId: string;
  readonly opportunityId: string;
  readonly kind: "remote" | "physical";
  readonly executionDecision: "human_fulfillment" | "hybrid";
  readonly source: {
    readonly title: string;
    readonly url?: string | undefined;
  };
  readonly internalEconomics: {
    readonly upstreamPayout: RankedOpportunity["evaluationRecord"]["evaluation"]["economics"]["payout"];
    readonly estimatedWorkerCost: RankedOpportunity["evaluationRecord"]["evaluation"]["economics"]["executionCost"];
    readonly estimatedMargin: RankedOpportunity["evaluationRecord"]["evaluation"]["economics"]["margin"];
    readonly commercialReadiness: NonNullable<OpportunityExecutionPlan["humanFulfillment"]>["commercialReadiness"];
  };
  readonly recruitment: {
    readonly preferredChannels: readonly HumanRecruitmentChannel[];
    readonly purpose: "collect_quote_and_candidate";
    readonly requiredInputs: readonly (HumanRecruitmentRequiredInput | "physical_location_and_safety")[];
    readonly workerFacingOutline: readonly string[];
    readonly guidance: readonly string[];
  };
  readonly boundary: {
    readonly externalActionsAllowed: false;
    readonly publishAllowed: false;
    readonly contactAllowed: false;
    readonly compensationPromiseAllowed: false;
    readonly paymentAllowed: false;
  };
}

export interface HumanFulfillmentContractTerms {
  readonly workerReference: string;
  readonly taskBrief: string;
  readonly acceptanceCriteria: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly fullCompensationUsd: number;
  readonly goodFaithAttemptCompensationUsd: number;
  readonly dueAt?: string | undefined;
}

export interface HumanFulfillmentContractDraft {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof HUMAN_FULFILLMENT_POLICY_VERSION;
  readonly contractId: string;
  readonly recruitmentDraftId: string;
  readonly opportunityId: string;
  readonly kind: HumanRecruitmentDraft["kind"];
  readonly terms: {
    readonly workerReference: string;
    readonly taskBrief: string;
    readonly acceptanceCriteria: readonly string[];
    readonly evidenceRequirements: readonly string[];
    readonly fullCompensationUsd: number;
    readonly goodFaithAttemptCompensationUsd: number;
    readonly dueAt?: string | undefined;
  };
  readonly financial: {
    readonly upstreamPayout: HumanRecruitmentDraft["internalEconomics"]["upstreamPayout"];
    readonly grossMarginFloorUsd: number | null;
    readonly paymentAuthorizationReady: boolean;
    readonly blockers: readonly string[];
  };
  readonly compensationPolicy: {
    readonly accepted: "full_agreed_compensation";
    readonly goodFaithFailed: "contract_defined_partial_compensation";
    readonly noMeaningfulEffort: "no_compensation";
    readonly establishedFraud: "no_compensation";
    readonly suspicious: "manual_review_no_automatic_denial";
  };
  readonly boundary: {
    readonly contractIsDraft: true;
    readonly workerAcceptanceRequired: true;
    readonly explicitFinancialAuthorizationRequired: true;
    readonly paymentExecutionAllowed: false;
  };
}

export const HUMAN_FULFILLMENT_REVIEW_OUTCOMES = [
  "accepted",
  "good_faith_failed",
  "no_meaningful_effort",
  "established_fraud",
  "suspicious",
] as const;
export type HumanFulfillmentReviewOutcome = (typeof HUMAN_FULFILLMENT_REVIEW_OUTCOMES)[number];

export interface HumanFulfillmentReviewInput {
  readonly outcome: HumanFulfillmentReviewOutcome;
  readonly evidenceSummary: readonly string[];
  readonly reviewedAt: string;
}

export interface HumanFulfillmentReviewRecord {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly reviewedAt: string;
  readonly outcome: HumanFulfillmentReviewOutcome;
  readonly evidenceSummary: readonly string[];
  readonly compensation: {
    readonly status: "full_due" | "partial_due" | "none" | "manual_review";
    readonly amountUsd: number | null;
    readonly rationale: string;
  };
  readonly boundary: {
    readonly paymentExecutionAllowed: false;
    readonly explicitFinancialAuthorizationRequired: true;
  };
}

function uniqueNonEmpty(values: readonly string[], maxItems = 32, maxChars = 2_000): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    if (value.length > maxChars) throw new Error(`text item exceeds ${String(maxChars)} characters`);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return Object.freeze(out);
}

function assertFiniteUsd(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative USD amount`);
  }
  const cents = value * 100;
  if (Math.abs(Math.round(cents) - cents) > 1e-9) {
    throw new Error(`${name} must have at most two decimal places`);
  }
}

function assertIsoTimestamp(name: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid timestamp`);
}

function normalizeChannels(channels: readonly HumanRecruitmentChannel[]): readonly HumanRecruitmentChannel[] {
  const selected = channels.length === 0 ? (["reddit", "marketplace"] as const) : channels;
  return Object.freeze([...new Set(selected)]);
}

/**
 * Prepare a controlled worker-recruitment draft from an already-routed human plan.
 * No raw opportunity body, source title, upstream payout, or internal scoring is
 * placed in the worker-facing outline. This remains internal preparation only.
 */
export function buildHumanRecruitmentDraft(
  entry: RankedOpportunity,
  executionPlan: OpportunityExecutionPlan,
  preferredChannels: readonly HumanRecruitmentChannel[] = [],
): HumanRecruitmentDraft {
  if (entry.opportunity.id !== executionPlan.opportunityId) {
    throw new Error("execution plan does not belong to ranked opportunity");
  }
  if (
    executionPlan.decision !== "human_fulfillment" &&
    executionPlan.decision !== "hybrid"
  ) {
    throw new Error(`human recruitment requires a human or hybrid execution decision, got ${executionPlan.decision}`);
  }
  const human = executionPlan.humanFulfillment;
  if (human === null) throw new Error("human recruitment requires a human fulfillment plan");
  if (entry.evaluationFreshness !== "current") {
    throw new Error("human recruitment requires a current opportunity evaluation");
  }

  const channels = normalizeChannels(preferredChannels);
  const requiredInputs: (HumanRecruitmentRequiredInput | "physical_location_and_safety")[] = [
    ...HUMAN_RECRUITMENT_REQUIRED_INPUTS,
  ];
  if (human.kind === "physical") requiredInputs.push("physical_location_and_safety");

  const workerFacingOutline = uniqueNonEmpty([
    `Paid ${human.kind} task opportunity.`,
    "Exact scope, acceptance criteria, timeline, evidence requirements, and compensation must be supplied from an approved fulfillment contract before this draft can be posted.",
    human.kind === "physical"
      ? "Exact location, access requirements, travel expectations, and safety constraints must be verified before recruitment."
      : "Any required working hours, time-zone, account access, or collaboration constraints must be confirmed before recruitment.",
  ]);

  const draftId = `hrecruit_${canonicalHash({
    policyVersion: HUMAN_FULFILLMENT_POLICY_VERSION,
    opportunityId: entry.opportunity.id,
    currentRequestId: entry.currentRequestId,
    decision: executionPlan.decision,
    kind: human.kind,
    channels,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    policyVersion: HUMAN_FULFILLMENT_POLICY_VERSION,
    draftId,
    opportunityId: entry.opportunity.id,
    kind: human.kind,
    executionDecision: executionPlan.decision,
    source: Object.freeze({
      title: entry.opportunity.title,
      ...(entry.opportunity.url === undefined ? {} : { url: entry.opportunity.url }),
    }),
    internalEconomics: Object.freeze({
      upstreamPayout: executionPlan.economics.payout,
      estimatedWorkerCost: executionPlan.economics.executionCost,
      estimatedMargin: executionPlan.economics.margin,
      commercialReadiness: human.commercialReadiness,
    }),
    recruitment: Object.freeze({
      preferredChannels: channels,
      purpose: "collect_quote_and_candidate" as const,
      requiredInputs: Object.freeze(requiredInputs),
      workerFacingOutline,
      guidance: Object.freeze([
        "Internal preparation only. Verify the target platform/community rules before any post or contact.",
        "Do not expose the upstream buyer payout, source title, internal margin, model score, risk label, or evaluator reasoning to a worker unless the operator intentionally chooses to disclose a source fact later.",
        "Do not promise compensation until a concrete worker-facing contract has been reviewed and explicitly authorized.",
        "Do not ask a worker to begin execution before scope, acceptance, evidence, timeline, and compensation terms are fixed.",
      ]),
    }),
    boundary: Object.freeze({
      externalActionsAllowed: false as const,
      publishAllowed: false as const,
      contactAllowed: false as const,
      compensationPromiseAllowed: false as const,
      paymentAllowed: false as const,
    }),
  });
}

function financialState(
  draft: HumanRecruitmentDraft,
  fullCompensationUsd: number,
): HumanFulfillmentContractDraft["financial"] {
  const payout = draft.internalEconomics.upstreamPayout;
  const blockers: string[] = [];
  let grossMarginFloorUsd: number | null = null;
  if (payout === null) {
    blockers.push("upstream total USD payout is not established");
  } else {
    grossMarginFloorUsd = Math.round((payout.minUsd - fullCompensationUsd) * 100) / 100;
    if (grossMarginFloorUsd <= 0) {
      blockers.push("worker full compensation leaves no positive gross margin at the upstream payout floor");
    }
  }
  return Object.freeze({
    upstreamPayout: payout,
    grossMarginFloorUsd,
    paymentAuthorizationReady: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

/**
 * Freeze the worker-facing task and compensation terms into a deterministic draft.
 * The draft is still non-binding inside this runtime and never authorizes payment.
 */
export function buildHumanFulfillmentContractDraft(
  recruitment: HumanRecruitmentDraft,
  terms: HumanFulfillmentContractTerms,
): HumanFulfillmentContractDraft {
  const workerReference = terms.workerReference.trim();
  const taskBrief = terms.taskBrief.trim();
  if (workerReference === "" || workerReference.length > 512) {
    throw new Error("workerReference must be 1-512 characters");
  }
  if (taskBrief === "" || taskBrief.length > 20_000) {
    throw new Error("taskBrief must be 1-20000 characters");
  }
  const acceptanceCriteria = uniqueNonEmpty(terms.acceptanceCriteria, 32, 2_000);
  const evidenceRequirements = uniqueNonEmpty(terms.evidenceRequirements, 32, 2_000);
  if (acceptanceCriteria.length === 0) throw new Error("at least one acceptance criterion is required");
  if (evidenceRequirements.length === 0) throw new Error("at least one evidence requirement is required");

  assertFiniteUsd("fullCompensationUsd", terms.fullCompensationUsd);
  assertFiniteUsd("goodFaithAttemptCompensationUsd", terms.goodFaithAttemptCompensationUsd);
  if (terms.fullCompensationUsd <= 0) throw new Error("fullCompensationUsd must be greater than zero");
  if (terms.goodFaithAttemptCompensationUsd <= 0) {
    throw new Error("goodFaithAttemptCompensationUsd must be greater than zero");
  }
  if (terms.goodFaithAttemptCompensationUsd >= terms.fullCompensationUsd) {
    throw new Error("goodFaithAttemptCompensationUsd must be lower than fullCompensationUsd");
  }
  if (terms.dueAt !== undefined) assertIsoTimestamp("dueAt", terms.dueAt);

  const financial = financialState(recruitment, terms.fullCompensationUsd);
  const normalizedTerms = Object.freeze({
    workerReference,
    taskBrief,
    acceptanceCriteria,
    evidenceRequirements,
    fullCompensationUsd: terms.fullCompensationUsd,
    goodFaithAttemptCompensationUsd: terms.goodFaithAttemptCompensationUsd,
    ...(terms.dueAt === undefined ? {} : { dueAt: terms.dueAt }),
  });
  const contractId = `hcontract_${canonicalHash({
    policyVersion: HUMAN_FULFILLMENT_POLICY_VERSION,
    recruitmentDraftId: recruitment.draftId,
    terms: normalizedTerms,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    policyVersion: HUMAN_FULFILLMENT_POLICY_VERSION,
    contractId,
    recruitmentDraftId: recruitment.draftId,
    opportunityId: recruitment.opportunityId,
    kind: recruitment.kind,
    terms: normalizedTerms,
    financial,
    compensationPolicy: Object.freeze({
      accepted: "full_agreed_compensation" as const,
      goodFaithFailed: "contract_defined_partial_compensation" as const,
      noMeaningfulEffort: "no_compensation" as const,
      establishedFraud: "no_compensation" as const,
      suspicious: "manual_review_no_automatic_denial" as const,
    }),
    boundary: Object.freeze({
      contractIsDraft: true as const,
      workerAcceptanceRequired: true as const,
      explicitFinancialAuthorizationRequired: true as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

function compensationForOutcome(
  contract: HumanFulfillmentContractDraft,
  outcome: HumanFulfillmentReviewOutcome,
): HumanFulfillmentReviewRecord["compensation"] {
  switch (outcome) {
    case "accepted":
      return Object.freeze({
        status: "full_due" as const,
        amountUsd: contract.terms.fullCompensationUsd,
        rationale: "deliverable passed the frozen acceptance criteria",
      });
    case "good_faith_failed":
      return Object.freeze({
        status: "partial_due" as const,
        amountUsd: contract.terms.goodFaithAttemptCompensationUsd,
        rationale: "documented good-faith attempt failed acceptance and uses the pre-agreed partial compensation",
      });
    case "no_meaningful_effort":
      return Object.freeze({
        status: "none" as const,
        amountUsd: 0,
        rationale: "review established that meaningful contract performance was not attempted",
      });
    case "established_fraud":
      return Object.freeze({
        status: "none" as const,
        amountUsd: 0,
        rationale: "review established fraud; suspicion alone is not sufficient for this outcome",
      });
    case "suspicious":
      return Object.freeze({
        status: "manual_review" as const,
        amountUsd: null,
        rationale: "red flags require further review and do not automatically deny compensation",
      });
  }
}

/**
 * Record a QA/review outcome against the frozen contract. This calculates what
 * the contract says is due but still cannot execute or authorize a payment.
 */
export function reviewHumanFulfillmentAttempt(
  contract: HumanFulfillmentContractDraft,
  input: HumanFulfillmentReviewInput,
): HumanFulfillmentReviewRecord {
  assertIsoTimestamp("reviewedAt", input.reviewedAt);
  const evidenceSummary = uniqueNonEmpty(input.evidenceSummary, 64, 2_000);
  if (evidenceSummary.length === 0) throw new Error("at least one evidence summary item is required");
  const compensation = compensationForOutcome(contract, input.outcome);
  const reviewId = `hreview_${canonicalHash({
    contractId: contract.contractId,
    outcome: input.outcome,
    reviewedAt: input.reviewedAt,
    evidenceSummary,
  }).slice(0, 32)}`;
  return Object.freeze({
    schemaVersion: 1 as const,
    reviewId,
    contractId: contract.contractId,
    opportunityId: contract.opportunityId,
    reviewedAt: input.reviewedAt,
    outcome: input.outcome,
    evidenceSummary,
    compensation,
    boundary: Object.freeze({
      paymentExecutionAllowed: false as const,
      explicitFinancialAuthorizationRequired: true as const,
    }),
  });
}
