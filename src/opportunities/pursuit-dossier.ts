import { canonicalHash } from "../core/ids.js";
import type { OpportunityOperatorPreparationPacket } from "./operator-packet.js";

export const PURSUIT_DOSSIER_POLICY_VERSION = 1 as const;

export const PURSUIT_DOSSIER_STATUSES = [
  "blocked_on_checks",
  "operator_review_required",
  "ready_for_pursuit_decision",
] as const;
export type PursuitDossierStatus = (typeof PURSUIT_DOSSIER_STATUSES)[number];

export const PURSUIT_CONTACT_BRIEF_STATUSES = [
  "operator_review_blocked",
  "clarification_draft_ready",
  "operator_draft_ready",
] as const;
export type PursuitContactBriefStatus = (typeof PURSUIT_CONTACT_BRIEF_STATUSES)[number];

export interface OpportunityPursuitDossier {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof PURSUIT_DOSSIER_POLICY_VERSION;
  readonly dossierId: string;
  readonly sourcePacketId: string;
  readonly opportunity: OpportunityOperatorPreparationPacket["opportunity"];
  readonly status: PursuitDossierStatus;
  readonly safeNextStep: "resolve_checks" | "review_dossier" | "decide_whether_to_prepare_contact";
  readonly ranking: OpportunityOperatorPreparationPacket["ranking"];
  readonly economics: {
    readonly payout: OpportunityOperatorPreparationPacket["assessment"]["economics"]["payout"];
    readonly executionCost: OpportunityOperatorPreparationPacket["assessment"]["economics"]["executionCost"];
    readonly margin: OpportunityOperatorPreparationPacket["assessment"]["economics"]["margin"];
    readonly payoutKnown: boolean;
    readonly executionCostKnown: boolean;
    readonly marginKnown: boolean;
  };
  readonly executionPlan: {
    readonly route: OpportunityOperatorPreparationPacket["ranking"]["executionRoute"];
    readonly aiCanComplete: boolean;
    readonly humanRequired: boolean;
    readonly physicalPresence: boolean;
    readonly estimatedEffortMinutes: number | null;
    readonly preparationSteps: readonly string[];
  };
  readonly verification: {
    /** Controlled deterministic checks only; evaluator free text is not copied here. */
    readonly requiredChecks: readonly string[];
    readonly checkCount: number;
    readonly upstreamCheckCount: number;
    readonly upstreamChecksRequireOperatorReview: boolean;
    readonly blocking: boolean;
  };
  readonly contactBrief: {
    readonly status: PursuitContactBriefStatus;
    readonly intent: "hold_for_operator_review" | "clarify_before_commitment" | "express_interest_without_commitment";
    readonly sourceTitle: string;
    readonly sourceUrl?: string | undefined;
    /** Controlled drafting facts only; no evaluator reasons/blockers/nextChecks. */
    readonly talkingPoints: readonly string[];
    readonly clarificationItems: readonly string[];
    readonly draftGuidance: readonly string[];
    readonly requiresOperatorReview: true;
    readonly sendAllowed: false;
  };
  readonly boundary: OpportunityOperatorPreparationPacket["boundary"];
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return Object.freeze(out);
}

function routeCapabilityChecks(packet: OpportunityOperatorPreparationPacket): readonly string[] {
  const route = packet.ranking.executionRoute;
  const capabilities = packet.assessment.capabilities;
  const checks: string[] = [];
  if (route === "ai_direct") {
    if (!capabilities.aiCanComplete) checks.push("Resolve route mismatch: ai_direct requires aiCanComplete=true.");
    if (capabilities.humanRequired) checks.push("Resolve route mismatch: ai_direct cannot require a human executor.");
    if (capabilities.physicalPresence) checks.push("Resolve route mismatch: ai_direct cannot require physical presence.");
  } else if (route === "human_remote") {
    if (!capabilities.humanRequired) checks.push("Resolve route mismatch: human_remote requires a human executor.");
    if (capabilities.physicalPresence) checks.push("Resolve route mismatch: human_remote cannot require physical presence.");
  } else if (route === "human_physical") {
    if (!capabilities.humanRequired) checks.push("Resolve route mismatch: human_physical requires a human executor.");
    if (!capabilities.physicalPresence) checks.push("Resolve route mismatch: human_physical requires physicalPresence=true.");
  } else if (route === "hybrid") {
    if (!capabilities.aiCanComplete) checks.push("Resolve route mismatch: hybrid requires an AI-capable portion of the work.");
    if (!capabilities.humanRequired) checks.push("Resolve route mismatch: hybrid requires a human portion of the work.");
  }
  return Object.freeze(checks);
}

function controlledVerificationChecks(
  packet: OpportunityOperatorPreparationPacket,
  routeChecks: readonly string[],
): readonly string[] {
  const economics = packet.assessment.economics;
  const checks: string[] = [...routeChecks];
  if (packet.requiredChecks.length > 0) {
    checks.push(
      `Review ${String(packet.requiredChecks.length)} upstream operator-packet check(s) in ${packet.packetId} before any pursuit decision.`,
    );
  }
  if (economics.payout === null) {
    checks.push("Verify compensation and payment terms before any pursuit decision.");
  }
  if (economics.executionCost === null) {
    checks.push("Estimate execution cost before any pursuit decision.");
  }
  if (economics.margin === null) {
    checks.push("Calculate expected margin after compensation and execution cost are established.");
  }
  if (packet.ranking.executionRoute === "unknown") {
    checks.push("Determine the execution route before any pursuit decision.");
  }
  if (packet.opportunity.url === undefined) {
    checks.push("Locate and verify the current source listing before any pursuit decision.");
  }
  return uniqueNonEmpty(checks);
}

function dossierStatus(
  packet: OpportunityOperatorPreparationPacket,
  checks: readonly string[],
): { readonly status: PursuitDossierStatus; readonly safeNextStep: OpportunityPursuitDossier["safeNextStep"] } {
  if (checks.length > 0 || packet.readiness === "needs_checks") {
    return Object.freeze({ status: "blocked_on_checks" as const, safeNextStep: "resolve_checks" as const });
  }
  if (packet.readiness === "needs_operator_review" || packet.ranking.operatorAction === "manual_review") {
    return Object.freeze({ status: "operator_review_required" as const, safeNextStep: "review_dossier" as const });
  }
  return Object.freeze({
    status: "ready_for_pursuit_decision" as const,
    safeNextStep: "decide_whether_to_prepare_contact" as const,
  });
}

function executionPreparationSteps(
  packet: OpportunityOperatorPreparationPacket,
  routeChecks: readonly string[],
): readonly string[] {
  if (routeChecks.length > 0) {
    return Object.freeze([
      "Resolve execution-route/capability inconsistencies before constructing an execution plan.",
      ...routeChecks,
    ]);
  }
  const steps: string[] = [
    "Confirm the exact deliverables and acceptance criteria before making any commitment.",
    "Confirm the expected timeline or turnaround before making any commitment.",
  ];
  switch (packet.ranking.executionRoute) {
    case "ai_direct":
      steps.push("Define the AI-deliverable artifact, verification method, and operator QA gate before execution.");
      break;
    case "human_remote":
      steps.push("Identify a suitable remote executor, confirm availability/cost, and define a QA handoff before commitment.");
      break;
    case "human_physical":
      steps.push("Confirm exact location/logistics, identify a suitable physical executor, and calculate travel/execution cost before commitment.");
      break;
    case "hybrid":
      steps.push("Split the work into AI and human responsibilities, then define handoff and QA criteria for each part.");
      break;
    case "manual":
      steps.push("Keep execution operator-controlled until scope, responsibility, and acceptance criteria are fully established.");
      break;
    case "unknown":
      steps.push("Determine the real execution route before any pursuit decision.");
      break;
  }
  return uniqueNonEmpty([...steps, ...packet.deliveryConsiderations]);
}

function controlledClarificationItems(packet: OpportunityOperatorPreparationPacket): readonly string[] {
  const economics = packet.assessment.economics;
  const items: string[] = [
    "What are the exact deliverables and acceptance criteria?",
    "What timeline or turnaround is expected?",
  ];
  if (economics.payout === null) items.push("What compensation structure and payment terms apply?");
  switch (packet.ranking.executionRoute) {
    case "ai_direct":
      items.push("What output format, validation method, and acceptance test are required?");
      break;
    case "human_remote":
      items.push("Are there required working hours, time-zone, access, or collaboration constraints?");
      break;
    case "human_physical":
      items.push("What exact location, schedule, site-access, and on-site requirements apply?");
      break;
    case "hybrid":
      items.push("Which parts require human participation versus an automated/AI deliverable?");
      break;
    case "manual":
      items.push("What exact work and delivery responsibility should be handled manually?");
      break;
    case "unknown":
      items.push("Does any part of the work require a human executor or physical presence?");
      break;
  }
  return uniqueNonEmpty(items);
}

function controlledTalkingPoints(packet: OpportunityOperatorPreparationPacket): readonly string[] {
  const points = [
    "Reference the source listing by title without implying the work has already been accepted.",
    "Confirm scope, timeline, and acceptance criteria before making a commitment.",
  ];
  if (packet.assessment.economics.payout === null) {
    points.push("Clarify compensation and payment terms before discussing a commitment.");
  }
  return Object.freeze(points);
}

function contactBrief(
  packet: OpportunityOperatorPreparationPacket,
  status: PursuitDossierStatus,
  routeChecks: readonly string[],
): OpportunityPursuitDossier["contactBrief"] {
  const operatorBlocked = status === "operator_review_required" || routeChecks.length > 0;
  const checkBlocked = status === "blocked_on_checks";
  const briefStatus: PursuitContactBriefStatus = operatorBlocked
    ? "operator_review_blocked"
    : checkBlocked
      ? "clarification_draft_ready"
      : "operator_draft_ready";
  const intent = operatorBlocked
    ? "hold_for_operator_review" as const
    : checkBlocked
      ? "clarify_before_commitment" as const
      : "express_interest_without_commitment" as const;
  return Object.freeze({
    status: briefStatus,
    intent,
    sourceTitle: packet.opportunity.title,
    ...(packet.opportunity.url === undefined ? {} : { sourceUrl: packet.opportunity.url }),
    talkingPoints: controlledTalkingPoints(packet),
    clarificationItems: controlledClarificationItems(packet),
    draftGuidance: Object.freeze([
      "Treat this brief as internal preparation only; an operator must review any resulting message.",
      "Do not copy evaluator reasons, blockers, nextChecks, or raw listing-body text into a future message without independent operator review.",
      "Do not promise price, timing, delivery, acceptance, availability, or execution before the relevant checks and approvals are complete.",
      "Do not mention automated discovery, model scoring, internal risk labels, or internal execution routing.",
    ]),
    requiresOperatorReview: true as const,
    sendAllowed: false as const,
  });
}

/** Build an offline pursuit dossier. No network/model call or external mutation occurs here. */
export function buildOpportunityPursuitDossier(
  packet: OpportunityOperatorPreparationPacket,
): OpportunityPursuitDossier {
  if (packet.ranking.evaluationFreshness !== "current") {
    throw new Error("pursuit dossier requires a current evaluation");
  }
  if (packet.boundary.externalActionsAllowed !== false) {
    throw new Error("pursuit dossier requires external actions to remain disabled");
  }

  const routeChecks = routeCapabilityChecks(packet);
  const checks = controlledVerificationChecks(packet, routeChecks);
  const state = dossierStatus(packet, checks);
  const economics = packet.assessment.economics;
  const dossierId = `opdos_${canonicalHash({
    schemaVersion: 1,
    policyVersion: PURSUIT_DOSSIER_POLICY_VERSION,
    packet,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    policyVersion: PURSUIT_DOSSIER_POLICY_VERSION,
    dossierId,
    sourcePacketId: packet.packetId,
    opportunity: packet.opportunity,
    status: state.status,
    safeNextStep: state.safeNextStep,
    ranking: packet.ranking,
    economics: Object.freeze({
      payout: economics.payout,
      executionCost: economics.executionCost,
      margin: economics.margin,
      payoutKnown: economics.payout !== null,
      executionCostKnown: economics.executionCost !== null,
      marginKnown: economics.margin !== null,
    }),
    executionPlan: Object.freeze({
      route: packet.ranking.executionRoute,
      aiCanComplete: packet.assessment.capabilities.aiCanComplete,
      humanRequired: packet.assessment.capabilities.humanRequired,
      physicalPresence: packet.assessment.capabilities.physicalPresence,
      estimatedEffortMinutes: packet.assessment.estimatedEffortMinutes,
      preparationSteps: executionPreparationSteps(packet, routeChecks),
    }),
    verification: Object.freeze({
      requiredChecks: checks,
      checkCount: checks.length,
      upstreamCheckCount: packet.requiredChecks.length,
      upstreamChecksRequireOperatorReview: packet.requiredChecks.length > 0,
      blocking: checks.length > 0,
    }),
    contactBrief: contactBrief(packet, state.status, routeChecks),
    boundary: packet.boundary,
  });
}

export function buildOpportunityPursuitDossiers(
  packets: readonly OpportunityOperatorPreparationPacket[],
  limit = 25,
): readonly OpportunityPursuitDossier[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(1_000, Math.trunc(limit))) : 25;
  if (boundedLimit === 0) return Object.freeze([]);
  return Object.freeze(packets.slice(0, boundedLimit).map(buildOpportunityPursuitDossier));
}
