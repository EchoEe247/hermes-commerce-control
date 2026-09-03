import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOpportunityEvaluationPacket } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import type { PersistedOpportunityEvaluation } from "../src/opportunities/evaluation-results.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { prepareOpportunityOperatorPacket } from "../src/opportunities/operator-packet.js";
import { buildOpportunityPursuitDossier } from "../src/opportunities/pursuit-dossier.js";
import { rankOpportunity } from "../src/opportunities/ranking.js";
import { triageOpportunity } from "../src/opportunities/triage.js";
import {
  buildOpportunityVerificationPlan,
  OPPORTUNITY_VERIFICATION_POLICY_VERSION,
} from "../src/opportunities/verification-plan.js";
import {
  buildOpportunityVerificationResolution,
  JsonlOpportunityVerificationResolutionStore,
  type OpportunityVerificationResolution,
} from "../src/opportunities/verification-resolutions.js";

const candidate: OpportunityCandidate = {
  id: "opp_verify",
  source: "reddit_rss",
  externalId: "verify",
  title: "[HIRING] Remote API support",
  body: "Need remote help with an API project. Compensation details to discuss.",
  url: "https://www.reddit.com/r/forhire/comments/example/verify/",
  community: "forhire",
  observedAt: "2026-08-27T15:00:00.000Z",
  tags: ["reddit", "api"],
  metadata: {},
};

function dossier() {
  const triage = triageOpportunity(candidate, { requireDemand: true });
  const packet = buildOpportunityEvaluationPacket(candidate, triage);
  const requestId = buildPreparedOpportunityEvaluation(packet).requestId;
  const record: PersistedOpportunityEvaluation = {
    requestId,
    opportunityId: candidate.id,
    evaluatorId: "local-openai:hy3-free",
    evaluatedAt: "2026-08-27T15:05:00.000Z",
    evaluation: {
      schemaVersion: 1,
      recommendation: "manual_review",
      executionRoute: "human_remote",
      risk: "medium",
      confidence: 0.6,
      estimatedEffortMinutes: null,
      economics: { payout: null, executionCost: null, margin: null },
      capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: false },
      reasons: ["Internal reason that must not become verification evidence."],
      blockers: [],
      nextChecks: ["Confirm scope and buyer expectations"],
    },
  };
  const ranked = rankOpportunity(candidate, triage, record, requestId);
  return buildOpportunityPursuitDossier(prepareOpportunityOperatorPacket(ranked));
}

function byKind(plan: ReturnType<typeof buildOpportunityVerificationPlan>, kind: string) {
  const check = plan.checks.find((item) => item.kind === kind);
  assert.ok(check !== undefined, `missing ${kind} check`);
  return check;
}

function prerequisiteResolutions(current = dossier()) {
  const initial = buildOpportunityVerificationPlan(current);
  const upstream = byKind(initial, "upstream_operator_review");
  const compensation = byKind(initial, "compensation_terms");
  const executionCost = byKind(initial, "execution_cost");
  const margin = byKind(initial, "margin");
  const upstreamResolution = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: upstream.checkId,
    outcome: "satisfied",
    evidence: { kind: "operator_attestation", note: "Operator reviewed the upstream checks." },
    recordedAt: "2026-08-27T16:00:00.000Z",
  });
  const compensationResolution = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "source_reference",
      reference: "https://example.test/verified-compensation",
      note: "Source establishes the compensation terms.",
    },
    recordedAt: "2026-08-27T16:01:00.000Z",
  });
  const executionCostResolution = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: executionCost.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "executor_quote",
      reference: "quote:remote-executor-1",
      note: "Executor quote establishes expected execution cost.",
    },
    recordedAt: "2026-08-27T16:02:00.000Z",
  });
  return {
    current,
    initial,
    upstream,
    compensation,
    executionCost,
    margin,
    upstreamResolution,
    compensationResolution,
    executionCostResolution,
  };
}

function marginResolution(input: {
  current: ReturnType<typeof dossier>;
  checkId: string;
  dependencyResolutionIds?: readonly string[] | undefined;
  recordedAt?: string | undefined;
}): OpportunityVerificationResolution {
  return buildOpportunityVerificationResolution({
    dossierId: input.current.dossierId,
    checkId: input.checkId,
    outcome: "satisfied",
    evidence: { kind: "calculation", note: "Margin calculated from verified payout and execution cost." },
    ...(input.dependencyResolutionIds === undefined
      ? {}
      : { dependsOnResolutionIds: input.dependencyResolutionIds }),
    recordedAt: input.recordedAt ?? "2026-08-27T16:03:00.000Z",
  });
}

test("verification plan classifies controlled dossier checks without external actions", () => {
  const plan = buildOpportunityVerificationPlan(dossier());
  assert.equal(plan.policyVersion, OPPORTUNITY_VERIFICATION_POLICY_VERSION);
  assert.equal(OPPORTUNITY_VERIFICATION_POLICY_VERSION, 2);
  assert.match(plan.verificationPlanId, /^opvplan_[a-f0-9]{32}$/);
  assert.equal(plan.state, "needs_resolution");
  assert.equal(plan.nextSafeStep, "resolve_checks");
  assert.equal(plan.externalActionsAllowed, false);
  assert.equal(byKind(plan, "upstream_operator_review").state, "unresolved");
  assert.equal(byKind(plan, "compensation_terms").state, "requires_external_verification");
  assert.equal(byKind(plan, "execution_cost").state, "unresolved");
  const margin = byKind(plan, "margin");
  assert.equal(margin.state, "blocked_by_dependencies");
  assert.deepEqual(margin.currentDependencyResolutionIds, []);
});

test("compatible dependency-bound evidence resolves all checks but manual review remains mandatory", () => {
  const fixture = prerequisiteResolutions();
  const margin = marginResolution({
    current: fixture.current,
    checkId: fixture.margin.checkId,
    dependencyResolutionIds: [
      fixture.executionCostResolution.resolutionId,
      fixture.compensationResolution.resolutionId,
    ],
  });
  const plan = buildOpportunityVerificationPlan(fixture.current, [
    fixture.upstreamResolution,
    fixture.compensationResolution,
    fixture.executionCostResolution,
    margin,
  ]);
  assert.equal(plan.counts.resolved, plan.checks.length);
  assert.deepEqual(byKind(plan, "margin").currentDependencyResolutionIds, [
    fixture.compensationResolution.resolutionId,
    fixture.executionCostResolution.resolutionId,
  ].sort());
  assert.equal(plan.state, "operator_review_required");
  assert.equal(plan.nextSafeStep, "operator_review");
  assert.equal(plan.externalActionsAllowed, false);
});

test("derived calculation recorded before dependencies remains blocked or unresolved", () => {
  const fixture = prerequisiteResolutions();
  const earlyMargin = marginResolution({
    current: fixture.current,
    checkId: fixture.margin.checkId,
    dependencyResolutionIds: [
      fixture.compensationResolution.resolutionId,
      fixture.executionCostResolution.resolutionId,
    ],
    recordedAt: "2026-08-27T15:59:00.000Z",
  });

  const beforeDependencies = buildOpportunityVerificationPlan(fixture.current, [earlyMargin]);
  assert.equal(byKind(beforeDependencies, "margin").state, "blocked_by_dependencies");
  assert.equal(byKind(beforeDependencies, "margin").evidenceAccepted, false);

  const afterDependencies = buildOpportunityVerificationPlan(fixture.current, [
    fixture.upstreamResolution,
    fixture.compensationResolution,
    fixture.executionCostResolution,
    earlyMargin,
  ]);
  const margin = byKind(afterDependencies, "margin");
  assert.equal(margin.state, "unresolved");
  assert.equal(margin.evidenceAccepted, false);
  assert.deepEqual(margin.currentDependencyResolutionIds, [
    fixture.compensationResolution.resolutionId,
    fixture.executionCostResolution.resolutionId,
  ].sort());
});

test("derived calculation without exact dependency binding cannot resolve", () => {
  const fixture = prerequisiteResolutions();
  const unboundMargin = marginResolution({
    current: fixture.current,
    checkId: fixture.margin.checkId,
  });
  const plan = buildOpportunityVerificationPlan(fixture.current, [
    fixture.upstreamResolution,
    fixture.compensationResolution,
    fixture.executionCostResolution,
    unboundMargin,
  ]);
  const margin = byKind(plan, "margin");
  assert.equal(margin.state, "unresolved");
  assert.equal(margin.evidenceAccepted, false);
});

test("changing a dependency resolution invalidates an older derived calculation", () => {
  const fixture = prerequisiteResolutions();
  const margin = marginResolution({
    current: fixture.current,
    checkId: fixture.margin.checkId,
    dependencyResolutionIds: [
      fixture.compensationResolution.resolutionId,
      fixture.executionCostResolution.resolutionId,
    ],
  });
  const initiallyResolved = buildOpportunityVerificationPlan(fixture.current, [
    fixture.upstreamResolution,
    fixture.compensationResolution,
    fixture.executionCostResolution,
    margin,
  ]);
  assert.equal(byKind(initiallyResolved, "margin").state, "resolved");

  const newerCompensation = buildOpportunityVerificationResolution({
    dossierId: fixture.current.dossierId,
    checkId: fixture.compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "source_reference",
      reference: "https://example.test/verified-compensation-v2",
      note: "Newer source evidence changes the applied compensation record.",
    },
    recordedAt: "2026-08-27T16:04:00.000Z",
  });
  const changed = buildOpportunityVerificationPlan(fixture.current, [
    fixture.upstreamResolution,
    fixture.compensationResolution,
    fixture.executionCostResolution,
    margin,
    newerCompensation,
  ]);
  const changedMargin = byKind(changed, "margin");
  assert.equal(changedMargin.state, "unresolved");
  assert.equal(changedMargin.evidenceAccepted, false);
  assert.deepEqual(changedMargin.currentDependencyResolutionIds, [
    newerCompensation.resolutionId,
    fixture.executionCostResolution.resolutionId,
  ].sort());
  assert.equal(changed.state, "needs_resolution");
});

test("check-specific evidence cannot satisfy the wrong verification kind", () => {
  const current = dossier();
  const initial = buildOpportunityVerificationPlan(current);
  const compensation = byKind(initial, "compensation_terms");
  const wrong = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "executor_quote",
      reference: "quote:executor-only",
      note: "An executor quote does not verify buyer compensation.",
    },
    recordedAt: "2026-08-27T16:00:00.000Z",
  });
  const plan = buildOpportunityVerificationPlan(current, [wrong]);
  const check = byKind(plan, "compensation_terms");
  assert.equal(check.evidenceAccepted, false);
  assert.equal(check.state, "requires_external_verification");
});

test("later incompatible evidence does not erase earlier applicable evidence", () => {
  const current = dossier();
  const initial = buildOpportunityVerificationPlan(current);
  const compensation = byKind(initial, "compensation_terms");
  const valid = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "source_reference",
      reference: "https://example.test/compensation",
      note: "Verified compensation from the source.",
    },
    recordedAt: "2026-08-27T16:00:00.000Z",
  });
  const wrongLater = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "executor_quote",
      reference: "quote:not-buyer-compensation",
      note: "Wrong evidence type recorded later.",
    },
    recordedAt: "2026-08-27T17:00:00.000Z",
  });
  const plan = buildOpportunityVerificationPlan(current, [valid, wrongLater]);
  const check = byKind(plan, "compensation_terms");
  assert.equal(check.state, "resolved");
  assert.equal(check.appliedResolutionId, valid.resolutionId);
  assert.equal(check.evidenceAccepted, true);
});

test("resolution evidence is scoped to the current dossier identity", () => {
  const current = dossier();
  const initial = buildOpportunityVerificationPlan(current);
  const compensation = byKind(initial, "compensation_terms");
  const stale = buildOpportunityVerificationResolution({
    dossierId: `opdos_${"b".repeat(32)}`,
    checkId: compensation.checkId,
    outcome: "satisfied",
    evidence: {
      kind: "source_reference",
      reference: "https://example.test/stale",
      note: "Evidence from a different dossier revision.",
    },
    recordedAt: "2026-08-27T18:00:00.000Z",
  });
  const plan = buildOpportunityVerificationPlan(current, [stale]);
  const check = byKind(plan, "compensation_terms");
  assert.equal(check.state, "requires_external_verification");
  assert.equal(check.appliedResolutionId, null);
  assert.equal(check.evidenceAccepted, null);
});

test("a failed accepted check stops readiness at failed_check", () => {
  const current = dossier();
  const initial = buildOpportunityVerificationPlan(current);
  const compensation = byKind(initial, "compensation_terms");
  const failed = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: compensation.checkId,
    outcome: "failed",
    evidence: {
      kind: "source_reference",
      reference: "https://example.test/failed-check",
      note: "Source evidence contradicts the expected compensation terms.",
    },
    recordedAt: "2026-08-27T16:00:00.000Z",
  });
  const plan = buildOpportunityVerificationPlan(current, [failed]);
  assert.equal(byKind(plan, "compensation_terms").state, "failed");
  assert.equal(plan.state, "failed_check");
  assert.equal(plan.nextSafeStep, "review_failed_check");
});

test("external evidence records require a reference", () => {
  const current = dossier();
  const initial = buildOpportunityVerificationPlan(current);
  const compensation = byKind(initial, "compensation_terms");
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      dossierId: current.dossierId,
      checkId: compensation.checkId,
      outcome: "satisfied",
      evidence: { kind: "source_reference", note: "Missing required reference." },
      recordedAt: "2026-08-27T16:00:00.000Z",
    }),
  );
});

test("verification resolution store repairs a truncated tail before append", async () => {
  const current = dossier();
  const plan = buildOpportunityVerificationPlan(current);
  const upstream = byKind(plan, "upstream_operator_review");
  const dir = await mkdtemp(join(tmpdir(), "op-verification-"));
  const path = join(dir, "resolutions.jsonl");
  await writeFile(path, '{"schemaVersion":1,"resolutionId":"truncated', "utf8");
  const record = buildOpportunityVerificationResolution({
    dossierId: current.dossierId,
    checkId: upstream.checkId,
    outcome: "satisfied",
    evidence: { kind: "operator_attestation", note: "Reviewed." },
    recordedAt: "2026-08-27T16:00:00.000Z",
  });
  const store = new JsonlOpportunityVerificationResolutionStore(path);
  await store.append(record);
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.resolutionId, record.resolutionId);
  const body = await readFile(path, "utf8");
  assert.equal(body.endsWith("\n"), true);
  assert.doesNotMatch(body, /truncated/);
});
