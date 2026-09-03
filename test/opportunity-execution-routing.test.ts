import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityEvaluationPacket, type OpportunityEvaluation } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import type { PersistedOpportunityEvaluation } from "../src/opportunities/evaluation-results.js";
import { buildOpportunityExecutionPlan } from "../src/opportunities/execution-routing.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { rankOpportunity, type RankedOpportunity } from "../src/opportunities/ranking.js";
import { triageOpportunity } from "../src/opportunities/triage.js";

const opportunity: OpportunityCandidate = {
  id: "opp_execution",
  source: "reddit_rss",
  externalId: "execution",
  title: "[HIRING] Help complete a paid remote task",
  body: "Budget $200 total. Need reliable help to complete the task.",
  observedAt: "2026-08-30T10:00:00.000Z",
  tags: ["reddit", "hiring"],
  metadata: {},
};

function ranked(overrides: Partial<OpportunityEvaluation> = {}): RankedOpportunity {
  const triage = triageOpportunity(opportunity, { requireDemand: true });
  const packet = buildOpportunityEvaluationPacket(opportunity, triage);
  const requestId = buildPreparedOpportunityEvaluation(packet).requestId;
  const evaluation: OpportunityEvaluation = {
    schemaVersion: 1,
    recommendation: "pursue",
    executionRoute: "human_remote",
    risk: "low",
    confidence: 0.9,
    estimatedEffortMinutes: 60,
    economics: {
      payout: { minUsd: 200, maxUsd: null, basis: "observed" },
      executionCost: { minUsd: 60, maxUsd: 80, basis: "inferred" },
      margin: { minUsd: 120, maxUsd: 140, basis: "inferred" },
    },
    capabilities: {
      aiCanComplete: false,
      humanRequired: true,
      physicalPresence: false,
    },
    reasons: ["human execution is required"],
    blockers: [],
    nextChecks: [],
    ...overrides,
  };
  const record: PersistedOpportunityEvaluation = {
    requestId,
    opportunityId: opportunity.id,
    evaluatorId: "fixture",
    evaluatedAt: "2026-08-30T10:01:00.000Z",
    evaluation,
  };
  return rankOpportunity(opportunity, triage, record, requestId);
}

test("routes a clean AI-direct pursue candidate to agent execution", () => {
  const plan = buildOpportunityExecutionPlan(
    ranked({
      executionRoute: "ai_direct",
      capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
    }),
  );
  assert.equal(plan.decision, "agent_direct");
  assert.equal(plan.humanFulfillment, null);
  assert.match(plan.reasons.join(" "), /direct agent\/AI execution/i);
});

test("routes remote-human work into an analysis-only fulfillment plan", () => {
  const plan = buildOpportunityExecutionPlan(ranked());
  assert.equal(plan.decision, "human_fulfillment");
  assert.equal(plan.humanFulfillment?.kind, "remote");
  assert.equal(plan.humanFulfillment?.mode, "analysis_only");
  assert.equal(plan.humanFulfillment?.externalMutationAllowed, false);
  assert.equal(plan.humanFulfillment?.commercialReadiness, "economic_case_present");
  assert.deepEqual(plan.humanFulfillment?.estimatedWorkerCostUsd, {
    minUsd: 60,
    maxUsd: 80,
    basis: "inferred",
  });
  assert.equal(plan.humanFulfillment?.qualityPolicy.fullCompensationTiming, "after_acceptance");
  assert.equal(
    plan.humanFulfillment?.qualityPolicy.goodFaithAttemptCompensation,
    "contract_defined_partial_after_review",
  );
  assert.equal(plan.humanFulfillment?.qualityPolicy.noEffortOrFraudCompensation, "none_after_review");
  assert.equal(plan.humanFulfillment?.qualityPolicy.suspiciousCaseRequiresReview, true);
});

test("does not invent human economics when total payout or worker quote is missing", () => {
  const noPayout = buildOpportunityExecutionPlan(
    ranked({
      economics: {
        payout: null,
        executionCost: { minUsd: 30, maxUsd: 50, basis: "inferred" },
        margin: null,
      },
    }),
  );
  assert.equal(noPayout.humanFulfillment?.commercialReadiness, "needs_total_payout");

  const noQuote = buildOpportunityExecutionPlan(
    ranked({
      economics: {
        payout: { minUsd: 200, maxUsd: null, basis: "observed" },
        executionCost: null,
        margin: null,
      },
    }),
  );
  assert.equal(noQuote.humanFulfillment?.commercialReadiness, "needs_worker_quote");
  assert.equal(noQuote.humanFulfillment?.estimatedWorkerCostUsd, null);
});

test("marks physical human fulfillment for an explicit safety review", () => {
  const plan = buildOpportunityExecutionPlan(
    ranked({
      executionRoute: "human_physical",
      capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: true },
    }),
  );
  assert.equal(plan.decision, "human_fulfillment");
  assert.equal(plan.humanFulfillment?.kind, "physical");
  assert.equal(plan.humanFulfillment?.physicalSafetyReviewRequired, true);
});

test("hybrid work keeps an explicit human fulfillment component", () => {
  const plan = buildOpportunityExecutionPlan(
    ranked({
      executionRoute: "hybrid",
      capabilities: { aiCanComplete: true, humanRequired: true, physicalPresence: false },
    }),
  );
  assert.equal(plan.decision, "hybrid");
  assert.equal(plan.humanFulfillment?.kind, "remote");
});

test("execution-route capability contradictions fail to manual review", () => {
  const plan = buildOpportunityExecutionPlan(
    ranked({
      executionRoute: "human_remote",
      capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
    }),
  );
  assert.equal(plan.decision, "manual_review");
  assert.equal(plan.humanFulfillment, null);
  assert.match(plan.reasons.join(" "), /conflict/i);
});

test("explicit non-positive human margin remains visible as a commercial gate", () => {
  const plan = buildOpportunityExecutionPlan(
    ranked({
      economics: {
        payout: { minUsd: 50, maxUsd: null, basis: "observed" },
        executionCost: { minUsd: 50, maxUsd: 75, basis: "inferred" },
        margin: { minUsd: 0, maxUsd: 0, basis: "inferred" },
      },
    }),
  );
  assert.equal(plan.decision, "human_fulfillment");
  assert.equal(plan.humanFulfillment?.commercialReadiness, "nonpositive_margin");
  assert.match(plan.reasons.join(" "), /nonpositive_margin/);
});

test("ranking gates are preserved before execution routing", () => {
  const watch = buildOpportunityExecutionPlan(ranked({ recommendation: "watch" }));
  assert.equal(watch.decision, "watch");

  const manual = buildOpportunityExecutionPlan(ranked({ recommendation: "manual_review" }));
  assert.equal(manual.decision, "manual_review");

  const reject = buildOpportunityExecutionPlan(ranked({ recommendation: "reject" }));
  assert.equal(reject.decision, "reject");
});
