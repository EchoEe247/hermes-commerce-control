import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash } from "../src/core/ids.js";
import { OPPORTUNITY_EVALUATION_POLICY_VERSION } from "../src/opportunities/evaluation.js";
import { prepareOpportunityEvaluationQueue } from "../src/opportunities/evaluation-queue.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { resolveOpportunityProfile } from "../src/opportunities/profiles.js";
import type { OpportunityStore } from "../src/opportunities/store.js";

const rows: readonly OpportunityCandidate[] = [
  {
    id: "opp_queue_candidate",
    source: "reddit_rss",
    externalId: "queue-candidate",
    title: "[HIRING] Remote automation workflow",
    body: "Budget $150 per project. Need API integration and CRM automation.",
    author: "/u/not-needed-by-model",
    observedAt: "2026-08-27T15:00:00.000Z",
    tags: ["reddit", "automation"],
    metadata: { feedUrl: "https://www.reddit.com/example.rss" },
  },
  {
    id: "opp_queue_review",
    source: "reddit_rss",
    externalId: "queue-review",
    title: "Project files question",
    body: "Could use advice on organizing a folder structure.",
    observedAt: "2026-08-27T14:59:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
  {
    id: "opp_queue_reject",
    source: "reddit_rss",
    externalId: "queue-reject",
    title: "[FOR HIRE] Automation developer",
    body: "Available for projects. Remote.",
    observedAt: "2026-08-27T14:58:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
];

const store: OpportunityStore = {
  async seenIds() {
    return new Set(rows.map((row) => row.id));
  },
  async saveMany() {
    throw new Error("queue test store is read-only");
  },
  async list(limit = 500) {
    return rows.slice(0, limit);
  },
};

test("default evaluation queue prepares candidate and review but not deterministic reject", async () => {
  const queue = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
  );

  assert.deepEqual(
    queue.map((item) => [item.opportunityId, item.triageDecision]),
    [
      ["opp_queue_candidate", "candidate"],
      ["opp_queue_review", "review"],
    ],
  );
  assert.ok(queue.every((item) => item.requestId.startsWith("evalreq_")));
  assert.ok(queue.every((item) => item.policyVersion === OPPORTUNITY_EVALUATION_POLICY_VERSION));
  assert.ok(queue.every((item) => item.prompt.includes("Return JSON only")));
});

test("an explicitly empty decision list keeps the safe default rather than including rejects", async () => {
  const queue = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
    { decisions: [] },
  );
  assert.deepEqual(
    queue.map((item) => item.opportunityId),
    ["opp_queue_candidate", "opp_queue_review"],
  );
});

test("prepared queue identity is deterministic, policy-versioned, and packet omits author/source metadata", async () => {
  const first = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
    { decisions: ["candidate"], limit: 1 },
  );
  const second = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
    { decisions: ["candidate"], limit: 1 },
  );
  assert.equal(first[0]?.requestId, second[0]?.requestId);
  const prepared = first[0];
  assert.ok(prepared !== undefined);
  assert.equal(prepared.policyVersion, OPPORTUNITY_EVALUATION_POLICY_VERSION);
  const legacyPacketOnlyId = `evalreq_${canonicalHash(prepared.packet).slice(0, 32)}`;
  assert.notEqual(prepared.requestId, legacyPacketOnlyId);
  const packet = prepared.packet;
  assert.equal("author" in packet.opportunity, false);
  assert.equal("metadata" in packet.opportunity, false);
  assert.doesNotMatch(prepared.prompt, /not-needed-by-model/);
});

test("minimum score is applied before queue limit", async () => {
  const queue = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
    { decisions: ["candidate", "review"], minimumScore: 60, limit: 10 },
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.opportunityId, "opp_queue_candidate");
  assert.ok((queue[0]?.triageScore ?? 0) >= 60);
});

test("queue can explicitly include deterministic rejects for auditing without calling a model", async () => {
  const queue = await prepareOpportunityEvaluationQueue(
    store,
    resolveOpportunityProfile("demand").triage,
    { decisions: ["reject"], limit: 10 },
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.opportunityId, "opp_queue_reject");
  assert.equal(queue[0]?.triageDecision, "reject");
});
