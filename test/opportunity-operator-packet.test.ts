import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityEvaluationPacket } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import type { PersistedOpportunityEvaluation } from "../src/opportunities/evaluation-results.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import {
  EXTERNAL_ACTIONS_REQUIRING_APPROVAL,
  prepareOpportunityOperatorPacket,
  prepareOpportunityOperatorPackets,
} from "../src/opportunities/operator-packet.js";
import { rankOpportunity } from "../src/opportunities/ranking.js";
import { triageOpportunity } from "../src/opportunities/triage.js";

const candidate: OpportunityCandidate = {
  id: "opp_operator",
  source: "reddit_rss",
  externalId: "operator",
  title: "[HIRING] Remote API automation",
  body: "Need help with an API integration. Remote.",
  url: "https://www.reddit.com/r/forhire/comments/example/operator/",
  community: "forhire",
  observedAt: "2026-08-27T15:00:00.000Z",
  tags: ["reddit", "automation"],
  metadata: {},
};

function ranked(overrides: Partial<PersistedOpportunityEvaluation["evaluation"]> = {}) {
  const triage = triageOpportunity(candidate, { requireDemand: true });
  const packet = buildOpportunityEvaluationPacket(candidate, triage);
  const requestId = buildPreparedOpportunityEvaluation(packet).requestId;
  const evaluationRecord: PersistedOpportunityEvaluation = {
    requestId,
    opportunityId: candidate.id,
    evaluatorId: "local-openai:hy3-free",
    evaluatedAt: "2026-08-27T15:05:00.000Z",
    evaluation: {
      schemaVersion: 1,
      recommendation: "manual_review",
      executionRoute: "human_remote",
      risk: "medium",
      confidence: 0.5,
      estimatedEffortMinutes: null,
      economics: { payout: null, executionCost: null, margin: null },
      capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: false },
      reasons: ["requirements and compensation need review"],
      blockers: [],
      nextChecks: ["Confirm exact scope and acceptance criteria"],
      ...overrides,
    },
  };
  return rankOpportunity(candidate, triage, evaluationRecord, requestId);
}

test("manual-review packet surfaces checks, provenance, and explicit approval boundary", () => {
  const packet = prepareOpportunityOperatorPacket(ranked());
  assert.equal(packet.schemaVersion, 1);
  assert.match(packet.packetId, /^opprep_[a-f0-9]{32}$/);
  assert.equal(packet.ranking.operatorAction, "manual_review");
  assert.equal(packet.ranking.executionRoute, "human_remote");
  assert.equal(packet.ranking.evaluationFreshness, "current");
  assert.equal(packet.triage.decision === "candidate" || packet.triage.decision === "review", true);
  assert.equal(packet.readiness, "needs_checks");
  assert.equal(packet.nextSafeStep, "resolve_checks");
  assert.match(packet.requiredChecks.join(" "), /scope and acceptance criteria/i);
  assert.match(packet.requiredChecks.join(" "), /compensation and payment terms/i);
  assert.match(packet.requiredChecks.join(" "), /execution cost/i);
  assert.match(packet.deliveryConsiderations.join(" "), /remote human executor/i);
  assert.equal(packet.assessment.nextChecks.length, 1);
  assert.equal("body" in packet.opportunity, false, "raw listing body must not be copied into operator packet");
  assert.equal(packet.boundary.externalActionsAllowed, false);
  assert.deepEqual(packet.boundary.requiresExplicitApprovalBefore, EXTERNAL_ACTIONS_REQUIRING_APPROVAL);
});

test("clean pursue packet becomes ready only for an operator decision, not an external action", () => {
  const entry = ranked({
    recommendation: "pursue",
    executionRoute: "ai_direct",
    risk: "low",
    confidence: 0.9,
    estimatedEffortMinutes: 60,
    economics: {
      payout: { minUsd: 150, maxUsd: null, basis: "observed" },
      executionCost: { minUsd: 0, maxUsd: 10, basis: "inferred" },
      margin: { minUsd: 140, maxUsd: 150, basis: "inferred" },
    },
    capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
    blockers: [],
    nextChecks: [],
  });
  const packet = prepareOpportunityOperatorPacket(entry);
  assert.equal(entry.operatorAction, "review_for_pursuit");
  assert.equal(packet.readiness, "ready_for_operator_decision");
  assert.equal(packet.nextSafeStep, "operator_decision");
  assert.equal(packet.requiredChecks.length, 0);
  assert.equal(packet.boundary.externalActionsAllowed, false);
});

test("unknown economics or route cannot be marked ready for an operator decision", () => {
  const entry = ranked({
    recommendation: "pursue",
    executionRoute: "unknown",
    risk: "low",
    confidence: 0.8,
    economics: {
      payout: { minUsd: 100, maxUsd: null, basis: "observed" },
      executionCost: null,
      margin: null,
    },
    capabilities: { aiCanComplete: false, humanRequired: false, physicalPresence: false },
    blockers: [],
    nextChecks: [],
  });
  const packet = prepareOpportunityOperatorPacket(entry);
  assert.equal(packet.readiness, "needs_checks");
  assert.match(packet.requiredChecks.join(" "), /execution cost/i);
  assert.match(packet.requiredChecks.join(" "), /margin/i);
  assert.match(packet.requiredChecks.join(" "), /execution route/i);
});

test("packet identity is deterministic but changes when selected evaluation content changes", () => {
  const first = prepareOpportunityOperatorPacket(ranked());
  const again = prepareOpportunityOperatorPacket(ranked());
  const changed = prepareOpportunityOperatorPacket(ranked({ confidence: 0.6 }));
  assert.equal(first.packetId, again.packetId);
  assert.notEqual(first.packetId, changed.packetId);
});

test("stale, watch, and reject rows cannot become operator preparation packets", () => {
  const current = ranked();
  const stale = rankOpportunity(
    current.opportunity,
    current.triage,
    current.evaluationRecord,
    "evalreq_different_current_request",
  );
  assert.equal(stale.evaluationFreshness, "stale_rejected");
  assert.throws(() => prepareOpportunityOperatorPacket(stale), /current evaluation/i);

  const watch = ranked({ recommendation: "watch" });
  assert.equal(watch.operatorAction, "watch");
  assert.throws(() => prepareOpportunityOperatorPacket(watch), /does not support action/i);
  assert.deepEqual(prepareOpportunityOperatorPackets([watch]), []);

  const reject = ranked({ recommendation: "reject" });
  assert.equal(reject.operatorAction, "reject");
  assert.throws(() => prepareOpportunityOperatorPacket(reject), /does not support action/i);
  assert.deepEqual(prepareOpportunityOperatorPackets([reject]), []);
});

test("batch packet preparation honors a zero limit", () => {
  assert.deepEqual(prepareOpportunityOperatorPackets([ranked()], 0), []);
});
