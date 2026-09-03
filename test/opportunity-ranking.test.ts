import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityEvaluationPacket } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import type { OpportunityEvaluationResultStore, PersistedOpportunityEvaluation } from "../src/opportunities/evaluation-results.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { rankStoredOpportunities } from "../src/opportunities/ranking.js";
import type { OpportunityStore } from "../src/opportunities/store.js";
import { triageOpportunity, type OpportunityTriageProfile } from "../src/opportunities/triage.js";

const opportunities: readonly OpportunityCandidate[] = [
  {
    id: "opp_ai",
    source: "reddit_rss",
    externalId: "ai",
    title: "[HIRING] Remote API automation",
    body: "Budget $150 per project. Need API integration. Remote.",
    observedAt: "2026-08-27T15:00:00.000Z",
    tags: ["reddit", "automation"],
    metadata: {},
  },
  {
    id: "opp_manual",
    source: "reddit_rss",
    externalId: "manual",
    title: "[HIRING] Remote operations partner",
    body: "Paid remote operations support.",
    observedAt: "2026-08-27T14:59:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
  {
    id: "opp_supply",
    source: "reddit_rss",
    externalId: "supply",
    title: "[FOR HIRE] Automation developer",
    body: "Available for projects. Remote.",
    observedAt: "2026-08-27T14:58:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
];

const demandProfile: OpportunityTriageProfile = { requireDemand: true };

const opportunityStore: OpportunityStore = {
  async seenIds() {
    return new Set(opportunities.map((row) => row.id));
  },
  async saveMany() {
    throw new Error("ranking fixture is read-only");
  },
  async list(limit = 500) {
    return opportunities.slice(0, limit);
  },
};

function opportunityById(opportunityId: string): OpportunityCandidate {
  const row = opportunities.find((candidate) => candidate.id === opportunityId);
  if (row === undefined) throw new Error(`unknown fixture opportunity ${opportunityId}`);
  return row;
}

function requestIdFor(
  opportunityId: string,
  profile: OpportunityTriageProfile = demandProfile,
): string {
  const opportunity = opportunityById(opportunityId);
  const triage = triageOpportunity(opportunity, profile);
  return buildPreparedOpportunityEvaluation(
    buildOpportunityEvaluationPacket(opportunity, triage),
  ).requestId;
}

function evaluation(
  opportunityId: string,
  evaluatorId: string,
  evaluatedAt: string,
  overrides: Partial<PersistedOpportunityEvaluation["evaluation"]> = {},
  requestProfile: OpportunityTriageProfile = demandProfile,
): PersistedOpportunityEvaluation {
  return {
    requestId: requestIdFor(opportunityId, requestProfile),
    opportunityId,
    evaluatorId,
    evaluatedAt,
    evaluation: {
      schemaVersion: 1,
      recommendation: "manual_review",
      executionRoute: "human_remote",
      risk: "medium",
      confidence: 0.5,
      estimatedEffortMinutes: null,
      economics: { payout: null, executionCost: null, margin: null },
      capabilities: { aiCanComplete: false, humanRequired: true, physicalPresence: false },
      reasons: ["fixture"],
      blockers: [],
      nextChecks: [],
      ...overrides,
    },
  };
}

function evaluationStore(rows: readonly PersistedOpportunityEvaluation[]): OpportunityEvaluationResultStore {
  return {
    async seenKeys() {
      return new Set();
    },
    async append() {
      throw new Error("ranking fixture is read-only");
    },
    async list(limit) {
      return limit === undefined ? rows : rows.slice(0, limit);
    },
  };
}

test("pursue/low-risk AI opportunity outranks manual-review work", async () => {
  const rows = [
    evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z", {
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
    }),
    evaluation("opp_manual", "local-openai:hy3-free", "2026-08-27T15:02:00.000Z"),
  ];
  const ranked = await rankStoredOpportunities(opportunityStore, evaluationStore(rows), demandProfile, {
    asOf: "2026-08-27T16:00:00.000Z",
  });
  assert.equal(ranked[0]?.opportunity.id, "opp_ai");
  assert.equal(ranked[0]?.operatorAction, "review_for_pursuit");
  assert.equal(ranked[0]?.priorityBand, "high");
  assert.equal(ranked[0]?.evaluationFreshness, "current");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("high-risk pursue and unresolved blockers are routed to manual review", async () => {
  const rows = [
    evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z", {
      recommendation: "pursue",
      risk: "high",
      confidence: 0.8,
      blockers: ["counterparty identity not verified"],
    }),
  ];
  const ranked = await rankStoredOpportunities(opportunityStore, evaluationStore(rows), demandProfile, {
    asOf: "2026-08-27T16:00:00.000Z",
  });
  assert.equal(ranked[0]?.operatorAction, "manual_review");
  assert.match(ranked[0]?.routingReasons.join(" ") ?? "", /high-risk|blocker/i);
});

test("current deterministic reject overrides a stale positive evaluation", async () => {
  const rows = [
    evaluation(
      "opp_supply",
      "local-openai:hy3-free",
      "2026-08-27T15:01:00.000Z",
      {
        recommendation: "pursue",
        executionRoute: "ai_direct",
        risk: "low",
        confidence: 0.95,
        capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
      },
      {},
    ),
  ];
  const ranked = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore(rows),
    demandProfile,
    { actions: ["reject"], asOf: "2026-09-30T00:00:00.000Z" },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.operatorAction, "reject");
  assert.equal(ranked[0]?.score, 0);
  assert.equal(ranked[0]?.priorityBand, "blocked");
  assert.equal(ranked[0]?.evaluationFreshness, "stale_rejected");
  assert.notEqual(ranked[0]?.evaluationRecord.requestId, ranked[0]?.currentRequestId);
});

test("stale non-rejected model evaluation is not reused after triage packet changes", async () => {
  const old = evaluation("opp_manual", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z");
  const changedProfile: OpportunityTriageProfile = {
    requireDemand: true,
    preferredTerms: ["operations"],
  };
  assert.notEqual(old.requestId, requestIdFor("opp_manual", changedProfile));

  const ranked = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore([old]),
    changedProfile,
    { asOf: "2026-08-27T16:00:00.000Z" },
  );
  assert.equal(ranked.length, 0);
});

test("latest current evaluation wins by default and evaluator filter can select another model result", async () => {
  const older = evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z", {
    recommendation: "manual_review",
  });
  const newer = evaluation("opp_ai", "local-openai:mimo-v2.5-free", "2026-08-27T15:03:00.000Z", {
    recommendation: "pursue",
    executionRoute: "ai_direct",
    risk: "low",
    confidence: 0.8,
    capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
  });

  const latest = await rankStoredOpportunities(opportunityStore, evaluationStore([older, newer]), demandProfile, {
    asOf: "2026-08-27T16:00:00.000Z",
  });
  assert.equal(latest[0]?.evaluationRecord.evaluatorId, "local-openai:mimo-v2.5-free");
  assert.equal(latest[0]?.operatorAction, "review_for_pursuit");

  const filtered = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore([older, newer]),
    demandProfile,
    { evaluatorId: "local-openai:hy3-free", asOf: "2026-08-27T16:00:00.000Z" },
  );
  assert.equal(filtered[0]?.evaluationRecord.evaluatorId, "local-openai:hy3-free");
  assert.equal(filtered[0]?.operatorAction, "manual_review");
});

test("minimum score and action filters are applied after ranking", async () => {
  const rows = [
    evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z", {
      recommendation: "pursue",
      executionRoute: "ai_direct",
      risk: "low",
      confidence: 0.9,
      capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
    }),
    evaluation("opp_manual", "local-openai:hy3-free", "2026-08-27T15:02:00.000Z"),
  ];
  const ranked = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore(rows),
    demandProfile,
    { actions: ["review_for_pursuit"], minimumScore: 60, limit: 1, asOf: "2026-08-27T16:00:00.000Z" },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.opportunity.id, "opp_ai");
});

test("aged non-rejected opportunity/evaluation is excluded by default and can be included explicitly", async () => {
  const row = evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z", {
    recommendation: "pursue",
    executionRoute: "ai_direct",
    risk: "low",
    confidence: 0.9,
    capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
  });

  const aged = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore([row]),
    demandProfile,
    { asOf: "2026-09-05T16:00:00.000Z" },
  );
  assert.equal(aged.length, 0);

  const unbounded = await rankStoredOpportunities(
    opportunityStore,
    evaluationStore([row]),
    demandProfile,
    { asOf: "2026-09-05T16:00:00.000Z", maxAgeHours: 0 },
  );
  assert.equal(unbounded.length, 1);
});

test("ranking requests the full evaluation store before evaluator/opportunity filtering", async () => {
  const row = evaluation("opp_ai", "local-openai:hy3-free", "2026-08-27T15:01:00.000Z");
  let requestedLimit: number | undefined = 12345;
  const store: OpportunityEvaluationResultStore = {
    async seenKeys() {
      return new Set();
    },
    async append() {
      throw new Error("ranking fixture is read-only");
    },
    async list(limit) {
      requestedLimit = limit;
      return [row];
    },
  };

  const ranked = await rankStoredOpportunities(opportunityStore, store, demandProfile, {
    evaluatorId: "local-openai:hy3-free",
    asOf: "2026-08-27T16:00:00.000Z",
  });
  assert.equal(requestedLimit, undefined);
  assert.equal(ranked.length, 1);
});
