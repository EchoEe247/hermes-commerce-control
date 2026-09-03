import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityEvaluationPacket, type OpportunityEvaluation } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import type { PersistedOpportunityEvaluation } from "../src/opportunities/evaluation-results.js";
import { buildOpportunityExecutionPlan } from "../src/opportunities/execution-routing.js";
import {
  buildHumanFulfillmentContractDraft,
  buildHumanRecruitmentDraft,
  reviewHumanFulfillmentAttempt,
} from "../src/opportunities/human-fulfillment.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { rankOpportunity, type RankedOpportunity } from "../src/opportunities/ranking.js";
import { triageOpportunity } from "../src/opportunities/triage.js";

const opportunity: OpportunityCandidate = {
  id: "opp_worker",
  source: "reddit_rss",
  externalId: "worker",
  title: "[HIRING] Complete a remote research task",
  body: "Total budget $200. Need a careful human to complete the work.",
  url: "https://www.reddit.com/r/example/comments/abc/task/",
  observedAt: "2026-08-30T11:00:00.000Z",
  tags: ["reddit", "research"],
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
    estimatedEffortMinutes: 90,
    economics: {
      payout: { minUsd: 200, maxUsd: null, basis: "observed" },
      executionCost: { minUsd: 50, maxUsd: 80, basis: "inferred" },
      margin: { minUsd: 120, maxUsd: 150, basis: "inferred" },
    },
    capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: false },
    reasons: ["human execution required"],
    blockers: [],
    nextChecks: [],
    ...overrides,
  };
  const record: PersistedOpportunityEvaluation = {
    requestId,
    opportunityId: opportunity.id,
    evaluatorId: "fixture",
    evaluatedAt: "2026-08-30T11:01:00.000Z",
    evaluation,
  };
  return rankOpportunity(opportunity, triage, record, requestId);
}

function recruitment(entry: RankedOpportunity = ranked()) {
  const execution = buildOpportunityExecutionPlan(entry);
  return buildHumanRecruitmentDraft(entry, execution);
}

function contract() {
  return buildHumanFulfillmentContractDraft(recruitment(), {
    workerReference: "worker_candidate_17",
    taskBrief: "Research the supplied public sources and return the requested structured findings.",
    acceptanceCriteria: [
      "All requested fields are completed.",
      "Every factual finding includes the requested source evidence.",
    ],
    evidenceRequirements: ["Submit the final structured file and source links."],
    fullCompensationUsd: 70,
    goodFaithAttemptCompensationUsd: 20,
    dueAt: "2026-08-31T18:00:00.000Z",
  });
}

test("recruitment draft exposes controlled worker outline but not upstream economics", () => {
  const draft = recruitment();
  assert.equal(draft.kind, "remote");
  assert.equal(draft.executionDecision, "human_fulfillment");
  assert.equal(draft.boundary.publishAllowed, false);
  assert.equal(draft.boundary.contactAllowed, false);
  assert.equal(draft.boundary.compensationPromiseAllowed, false);
  assert.deepEqual(draft.recruitment.preferredChannels, ["reddit", "marketplace"]);
  assert.ok(draft.recruitment.requiredInputs.includes("acceptance_criteria"));
  assert.ok(draft.recruitment.requiredInputs.includes("agreed_compensation"));
  const workerFacing = draft.recruitment.workerFacingOutline.join(" ");
  assert.doesNotMatch(workerFacing, /\$200|upstream payout|margin|score|risk/i);
  assert.deepEqual(draft.internalEconomics.upstreamPayout, {
    minUsd: 200,
    maxUsd: null,
    basis: "observed",
  });
});

test("physical recruitment adds location and safety requirements", () => {
  const entry = ranked({
    executionRoute: "human_physical",
    capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: true },
  });
  const draft = recruitment(entry);
  assert.equal(draft.kind, "physical");
  assert.ok(draft.recruitment.requiredInputs.includes("physical_location_and_safety"));
  assert.match(draft.recruitment.workerFacingOutline.join(" "), /location.*safety/i);
});

test("non-human execution cannot create a worker recruitment draft", () => {
  const entry = ranked({
    executionRoute: "ai_direct",
    capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
  });
  const execution = buildOpportunityExecutionPlan(entry);
  assert.throws(
    () => buildHumanRecruitmentDraft(entry, execution),
    /requires a human or hybrid execution decision/,
  );
});

test("contract freezes scope, acceptance, evidence, and pre-agreed compensation", () => {
  const result = contract();
  assert.match(result.contractId, /^hcontract_/);
  assert.equal(result.terms.fullCompensationUsd, 70);
  assert.equal(result.terms.goodFaithAttemptCompensationUsd, 20);
  assert.equal(result.financial.grossMarginFloorUsd, 130);
  assert.equal(result.financial.paymentAuthorizationReady, true);
  assert.deepEqual(result.financial.blockers, []);
  assert.equal(result.boundary.contractIsDraft, true);
  assert.equal(result.boundary.workerAcceptanceRequired, true);
  assert.equal(result.boundary.paymentExecutionAllowed, false);
});

test("contract records financial blockers instead of authorizing an unprofitable payment", () => {
  const result = buildHumanFulfillmentContractDraft(recruitment(), {
    workerReference: "worker_candidate_18",
    taskBrief: "Complete the frozen task.",
    acceptanceCriteria: ["Deliverable passes the stated check."],
    evidenceRequirements: ["Provide the deliverable."],
    fullCompensationUsd: 200,
    goodFaithAttemptCompensationUsd: 25,
  });
  assert.equal(result.financial.grossMarginFloorUsd, 0);
  assert.equal(result.financial.paymentAuthorizationReady, false);
  assert.match(result.financial.blockers.join(" "), /no positive gross margin/i);
});

test("contract with unknown upstream payout remains financially blocked", () => {
  const entry = ranked({
    economics: {
      payout: null,
      executionCost: { minUsd: 50, maxUsd: 80, basis: "inferred" },
      margin: null,
    },
  });
  const draft = recruitment(entry);
  const result = buildHumanFulfillmentContractDraft(draft, {
    workerReference: "worker_candidate_19",
    taskBrief: "Complete the frozen task.",
    acceptanceCriteria: ["Deliverable passes the stated check."],
    evidenceRequirements: ["Provide the deliverable."],
    fullCompensationUsd: 50,
    goodFaithAttemptCompensationUsd: 10,
  });
  assert.equal(result.financial.grossMarginFloorUsd, null);
  assert.equal(result.financial.paymentAuthorizationReady, false);
  assert.match(result.financial.blockers.join(" "), /upstream total USD payout is not established/i);
});

test("contract rejects missing acceptance/evidence and invalid partial compensation", () => {
  const draft = recruitment();
  assert.throws(
    () =>
      buildHumanFulfillmentContractDraft(draft, {
        workerReference: "worker",
        taskBrief: "Task",
        acceptanceCriteria: [],
        evidenceRequirements: ["Evidence"],
        fullCompensationUsd: 50,
        goodFaithAttemptCompensationUsd: 10,
      }),
    /acceptance criterion/i,
  );
  assert.throws(
    () =>
      buildHumanFulfillmentContractDraft(draft, {
        workerReference: "worker",
        taskBrief: "Task",
        acceptanceCriteria: ["Pass"],
        evidenceRequirements: [],
        fullCompensationUsd: 50,
        goodFaithAttemptCompensationUsd: 10,
      }),
    /evidence requirement/i,
  );
  assert.throws(
    () =>
      buildHumanFulfillmentContractDraft(draft, {
        workerReference: "worker",
        taskBrief: "Task",
        acceptanceCriteria: ["Pass"],
        evidenceRequirements: ["Evidence"],
        fullCompensationUsd: 50,
        goodFaithAttemptCompensationUsd: 50,
      }),
    /must be lower/i,
  );
});

test("accepted review records full compensation due but cannot execute payment", () => {
  const review = reviewHumanFulfillmentAttempt(contract(), {
    outcome: "accepted",
    evidenceSummary: ["All acceptance criteria passed against submitted evidence."],
    reviewedAt: "2026-08-31T17:00:00.000Z",
  });
  assert.equal(review.compensation.status, "full_due");
  assert.equal(review.compensation.amountUsd, 70);
  assert.equal(review.boundary.paymentExecutionAllowed, false);
  assert.equal(review.boundary.explicitFinancialAuthorizationRequired, true);
});

test("good-faith failed review uses only the pre-agreed partial amount", () => {
  const review = reviewHumanFulfillmentAttempt(contract(), {
    outcome: "good_faith_failed",
    evidenceSummary: ["Worker supplied evidence of substantial attempt, but one frozen criterion failed."],
    reviewedAt: "2026-08-31T17:10:00.000Z",
  });
  assert.equal(review.compensation.status, "partial_due");
  assert.equal(review.compensation.amountUsd, 20);
});

test("no-effort and established-fraud outcomes record zero only after explicit review", () => {
  const noEffort = reviewHumanFulfillmentAttempt(contract(), {
    outcome: "no_meaningful_effort",
    evidenceSummary: ["Review found no submitted work or evidence of meaningful performance."],
    reviewedAt: "2026-08-31T17:20:00.000Z",
  });
  assert.equal(noEffort.compensation.status, "none");
  assert.equal(noEffort.compensation.amountUsd, 0);

  const fraud = reviewHumanFulfillmentAttempt(contract(), {
    outcome: "established_fraud",
    evidenceSummary: ["Review established that submitted evidence was fabricated."],
    reviewedAt: "2026-08-31T17:30:00.000Z",
  });
  assert.equal(fraud.compensation.status, "none");
  assert.equal(fraud.compensation.amountUsd, 0);
  assert.match(fraud.compensation.rationale, /suspicion alone is not sufficient/i);
});

test("suspicion alone cannot automatically deny compensation", () => {
  const review = reviewHumanFulfillmentAttempt(contract(), {
    outcome: "suspicious",
    evidenceSummary: ["Evidence has inconsistencies that require follow-up review."],
    reviewedAt: "2026-08-31T17:40:00.000Z",
  });
  assert.equal(review.compensation.status, "manual_review");
  assert.equal(review.compensation.amountUsd, null);
  assert.match(review.compensation.rationale, /do not automatically deny compensation/i);
});
