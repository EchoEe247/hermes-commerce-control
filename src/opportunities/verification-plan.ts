import { canonicalHash } from "../core/ids.js";
import type { OpportunityPursuitDossier } from "./pursuit-dossier.js";
import type {
  OpportunityVerificationResolution,
  VerificationEvidenceKind,
} from "./verification-resolutions.js";

/** Increment when check identity/evidence application semantics change. */
export const OPPORTUNITY_VERIFICATION_POLICY_VERSION = 2 as const;

export const OPPORTUNITY_VERIFICATION_CHECK_KINDS = [
  "upstream_operator_review",
  "compensation_terms",
  "execution_cost",
  "margin",
  "execution_route",
  "source_listing",
  "route_capability",
  "other_controlled",
] as const;
export type OpportunityVerificationCheckKind = (typeof OPPORTUNITY_VERIFICATION_CHECK_KINDS)[number];

export const OPPORTUNITY_VERIFICATION_RESOLUTION_MODES = [
  "operator_review",
  "external_verification",
  "local_estimate",
  "derived",
] as const;
export type OpportunityVerificationResolutionMode = (typeof OPPORTUNITY_VERIFICATION_RESOLUTION_MODES)[number];

export const OPPORTUNITY_VERIFICATION_CHECK_STATES = [
  "resolved",
  "failed",
  "requires_external_verification",
  "unresolved",
  "blocked_by_dependencies",
] as const;
export type OpportunityVerificationCheckState = (typeof OPPORTUNITY_VERIFICATION_CHECK_STATES)[number];

export const OPPORTUNITY_VERIFICATION_PLAN_STATES = [
  "needs_resolution",
  "failed_check",
  "operator_review_required",
  "ready_for_operator_decision",
] as const;
export type OpportunityVerificationPlanState = (typeof OPPORTUNITY_VERIFICATION_PLAN_STATES)[number];

export interface OpportunityVerificationCheck {
  readonly checkId: string;
  readonly kind: OpportunityVerificationCheckKind;
  readonly summary: string;
  readonly resolutionMode: OpportunityVerificationResolutionMode;
  readonly dependsOn: readonly string[];
  /** Exact currently-applied prerequisite resolution IDs a derived calculation must bind to. */
  readonly currentDependencyResolutionIds: readonly string[];
  readonly state: OpportunityVerificationCheckState;
  readonly appliedResolutionId: string | null;
  readonly evidenceAccepted: boolean | null;
}

export interface OpportunityVerificationPlan {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof OPPORTUNITY_VERIFICATION_POLICY_VERSION;
  readonly verificationPlanId: string;
  readonly dossierId: string;
  readonly opportunityId: string;
  readonly currentRequestId: string;
  readonly evaluatorId: string;
  readonly checks: readonly OpportunityVerificationCheck[];
  readonly counts: Readonly<Record<OpportunityVerificationCheckState, number>>;
  readonly state: OpportunityVerificationPlanState;
  readonly nextSafeStep: "resolve_checks" | "review_failed_check" | "operator_review" | "operator_decision";
  readonly externalActionsAllowed: false;
}

interface CheckDefinition {
  readonly checkId: string;
  readonly kind: OpportunityVerificationCheckKind;
  readonly summary: string;
  readonly resolutionMode: OpportunityVerificationResolutionMode;
  readonly dependsOn: readonly string[];
}

interface AppliedResolution {
  readonly record: OpportunityVerificationResolution;
  readonly accepted: boolean;
}

function classify(summary: string): {
  readonly kind: OpportunityVerificationCheckKind;
  readonly resolutionMode: OpportunityVerificationResolutionMode;
} {
  if (/^Review \d+ upstream operator-packet check\(s\)/i.test(summary)) {
    return { kind: "upstream_operator_review", resolutionMode: "operator_review" };
  }
  if (/compensation and payment terms/i.test(summary)) {
    return { kind: "compensation_terms", resolutionMode: "external_verification" };
  }
  if (/execution cost/i.test(summary) && !/margin/i.test(summary)) {
    return { kind: "execution_cost", resolutionMode: "local_estimate" };
  }
  if (/expected margin/i.test(summary)) {
    return { kind: "margin", resolutionMode: "derived" };
  }
  if (/execution route/i.test(summary) && !/^Resolve route mismatch:/i.test(summary)) {
    return { kind: "execution_route", resolutionMode: "operator_review" };
  }
  if (/source listing/i.test(summary)) {
    return { kind: "source_listing", resolutionMode: "external_verification" };
  }
  if (/^Resolve route mismatch:/i.test(summary)) {
    return { kind: "route_capability", resolutionMode: "operator_review" };
  }
  return { kind: "other_controlled", resolutionMode: "operator_review" };
}

function checkId(dossier: OpportunityPursuitDossier, kind: OpportunityVerificationCheckKind, summary: string): string {
  return `opcheck_${canonicalHash({
    policyVersion: OPPORTUNITY_VERIFICATION_POLICY_VERSION,
    dossierId: dossier.dossierId,
    kind,
    summary,
  }).slice(0, 32)}`;
}

function definitions(dossier: OpportunityPursuitDossier): readonly CheckDefinition[] {
  const out = dossier.verification.requiredChecks.map((summary) => {
    const classified = classify(summary);
    return {
      checkId: checkId(dossier, classified.kind, summary),
      kind: classified.kind,
      summary,
      resolutionMode: classified.resolutionMode,
      dependsOn: [] as string[],
    };
  });

  const compensation = out.find((item) => item.kind === "compensation_terms")?.checkId;
  const executionCost = out.find((item) => item.kind === "execution_cost")?.checkId;
  return Object.freeze(
    out.map((item) =>
      item.kind === "margin"
        ? Object.freeze({
            ...item,
            dependsOn: Object.freeze(
              [compensation, executionCost].filter((value): value is string => value !== undefined),
            ),
          })
        : Object.freeze({ ...item, dependsOn: Object.freeze([]) }),
    ),
  );
}

function resolutionIsNewer(
  candidate: OpportunityVerificationResolution,
  current: OpportunityVerificationResolution,
): boolean {
  const candidateTime = Date.parse(candidate.recordedAt);
  const currentTime = Date.parse(current.recordedAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.resolutionId.localeCompare(current.resolutionId) > 0;
}

function latestMatchingResolution(
  dossierId: string,
  checkIdValue: string,
  resolutions: readonly OpportunityVerificationResolution[],
  predicate: (resolution: OpportunityVerificationResolution) => boolean = () => true,
): OpportunityVerificationResolution | undefined {
  let latest: OpportunityVerificationResolution | undefined;
  for (const resolution of resolutions) {
    if (resolution.dossierId !== dossierId || resolution.checkId !== checkIdValue || !predicate(resolution)) continue;
    if (latest === undefined || resolutionIsNewer(resolution, latest)) latest = resolution;
  }
  return latest;
}

function evidenceAllowed(definition: CheckDefinition, evidenceKind: VerificationEvidenceKind): boolean {
  switch (definition.kind) {
    case "upstream_operator_review":
    case "execution_route":
    case "route_capability":
    case "other_controlled":
      return evidenceKind === "operator_attestation";
    case "compensation_terms":
      return evidenceKind === "source_reference" || evidenceKind === "counterparty_confirmation";
    case "execution_cost":
      return evidenceKind === "calculation" || evidenceKind === "executor_quote";
    case "margin":
      return evidenceKind === "calculation";
    case "source_listing":
      return evidenceKind === "source_reference";
  }
}

function defaultUnresolvedState(definition: CheckDefinition): OpportunityVerificationCheckState {
  return definition.resolutionMode === "external_verification"
    ? "requires_external_verification"
    : "unresolved";
}

function sameResolutionIdSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  const left = [...(actual ?? [])].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordedAfterDependencies(
  resolution: OpportunityVerificationResolution,
  dependencies: readonly OpportunityVerificationResolution[],
): boolean {
  const resolutionTime = Date.parse(resolution.recordedAt);
  return dependencies.every((dependency) => resolutionTime >= Date.parse(dependency.recordedAt));
}

function emptyCounts(): Record<OpportunityVerificationCheckState, number> {
  return {
    resolved: 0,
    failed: 0,
    requires_external_verification: 0,
    unresolved: 0,
    blocked_by_dependencies: 0,
  };
}

/**
 * Apply append-only verification evidence to one current pursuit dossier.
 *
 * Non-derived checks are resolved first. Derived evidence is accepted only when all
 * prerequisites are currently resolved, the calculation is recorded no earlier than
 * those prerequisite records, and its dependsOnResolutionIds exactly match the current
 * prerequisite resolution IDs. Changing a prerequisite therefore invalidates an old
 * derived calculation automatically.
 *
 * Evidence remains scoped to current dossier/check identity and this layer never
 * authorizes external activity; a fully resolved plan still ends at an operator gate.
 */
export function buildOpportunityVerificationPlan(
  dossier: OpportunityPursuitDossier,
  resolutions: readonly OpportunityVerificationResolution[] = [],
): OpportunityVerificationPlan {
  if (dossier.boundary.externalActionsAllowed !== false) {
    throw new Error("verification plan requires external actions to remain disabled");
  }

  const defs = definitions(dossier);
  const states = new Map<string, OpportunityVerificationCheckState>();
  const applied = new Map<string, AppliedResolution>();
  const dependencyIds = new Map<string, readonly string[]>();

  // Pass 1: resolve independent/non-derived checks only.
  for (const definition of defs) {
    if (definition.resolutionMode === "derived") continue;
    const latestAny = latestMatchingResolution(dossier.dossierId, definition.checkId, resolutions);
    const latestApplicable = latestMatchingResolution(
      dossier.dossierId,
      definition.checkId,
      resolutions,
      (resolution) => evidenceAllowed(definition, resolution.evidence.kind),
    );
    if (latestApplicable !== undefined) {
      applied.set(definition.checkId, { record: latestApplicable, accepted: true });
      states.set(definition.checkId, latestApplicable.outcome === "satisfied" ? "resolved" : "failed");
    } else {
      states.set(definition.checkId, defaultUnresolvedState(definition));
      if (latestAny !== undefined) applied.set(definition.checkId, { record: latestAny, accepted: false });
    }
  }

  // Pass 2: derived checks can only use the exact currently-applied prerequisite evidence.
  for (const definition of defs) {
    if (definition.resolutionMode !== "derived") continue;
    const dependencyRecords: OpportunityVerificationResolution[] = [];
    let dependenciesResolved = true;
    for (const dependencyId of definition.dependsOn) {
      const dependencyApplied = applied.get(dependencyId);
      if (
        states.get(dependencyId) !== "resolved" ||
        dependencyApplied === undefined ||
        !dependencyApplied.accepted
      ) {
        dependenciesResolved = false;
        break;
      }
      dependencyRecords.push(dependencyApplied.record);
    }

    const currentDependencyResolutionIds = dependenciesResolved
      ? Object.freeze(dependencyRecords.map((record) => record.resolutionId).sort())
      : Object.freeze([] as string[]);
    dependencyIds.set(definition.checkId, currentDependencyResolutionIds);

    const latestAny = latestMatchingResolution(dossier.dossierId, definition.checkId, resolutions);
    if (!dependenciesResolved) {
      states.set(definition.checkId, "blocked_by_dependencies");
      if (latestAny !== undefined) applied.set(definition.checkId, { record: latestAny, accepted: false });
      continue;
    }

    const latestApplicable = latestMatchingResolution(
      dossier.dossierId,
      definition.checkId,
      resolutions,
      (resolution) =>
        evidenceAllowed(definition, resolution.evidence.kind) &&
        sameResolutionIdSet(resolution.dependsOnResolutionIds, currentDependencyResolutionIds) &&
        recordedAfterDependencies(resolution, dependencyRecords),
    );
    if (latestApplicable !== undefined) {
      applied.set(definition.checkId, { record: latestApplicable, accepted: true });
      states.set(definition.checkId, latestApplicable.outcome === "satisfied" ? "resolved" : "failed");
    } else {
      states.set(definition.checkId, "unresolved");
      if (latestAny !== undefined) applied.set(definition.checkId, { record: latestAny, accepted: false });
    }
  }

  const checks = Object.freeze(
    defs.map((definition) => {
      const appliedResolution = applied.get(definition.checkId);
      return Object.freeze({
        ...definition,
        currentDependencyResolutionIds: dependencyIds.get(definition.checkId) ?? Object.freeze([]),
        state: states.get(definition.checkId) ?? defaultUnresolvedState(definition),
        appliedResolutionId: appliedResolution?.record.resolutionId ?? null,
        evidenceAccepted: appliedResolution?.accepted ?? null,
      });
    }),
  );

  const counts = emptyCounts();
  for (const check of checks) counts[check.state] += 1;

  let state: OpportunityVerificationPlanState;
  let nextSafeStep: OpportunityVerificationPlan["nextSafeStep"];
  if (counts.failed > 0) {
    state = "failed_check";
    nextSafeStep = "review_failed_check";
  } else if (counts.resolved !== checks.length) {
    state = "needs_resolution";
    nextSafeStep = "resolve_checks";
  } else if (dossier.ranking.operatorAction === "manual_review") {
    state = "operator_review_required";
    nextSafeStep = "operator_review";
  } else {
    state = "ready_for_operator_decision";
    nextSafeStep = "operator_decision";
  }

  const verificationPlanId = `opvplan_${canonicalHash({
    schemaVersion: 1,
    policyVersion: OPPORTUNITY_VERIFICATION_POLICY_VERSION,
    dossierId: dossier.dossierId,
    currentRequestId: dossier.ranking.currentRequestId,
    checks: checks.map((check) => ({
      checkId: check.checkId,
      state: check.state,
      currentDependencyResolutionIds: check.currentDependencyResolutionIds,
      appliedResolutionId: check.appliedResolutionId,
      evidenceAccepted: check.evidenceAccepted,
    })),
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    policyVersion: OPPORTUNITY_VERIFICATION_POLICY_VERSION,
    verificationPlanId,
    dossierId: dossier.dossierId,
    opportunityId: dossier.opportunity.id,
    currentRequestId: dossier.ranking.currentRequestId,
    evaluatorId: dossier.ranking.evaluatorId,
    checks,
    counts: Object.freeze(counts),
    state,
    nextSafeStep,
    externalActionsAllowed: false as const,
  });
}

export function buildOpportunityVerificationPlans(
  dossiers: readonly OpportunityPursuitDossier[],
  resolutions: readonly OpportunityVerificationResolution[] = [],
  limit = 25,
): readonly OpportunityVerificationPlan[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(1_000, Math.trunc(limit))) : 25;
  if (boundedLimit === 0) return Object.freeze([]);
  return Object.freeze(dossiers.slice(0, boundedLimit).map((dossier) => buildOpportunityVerificationPlan(dossier, resolutions)));
}
