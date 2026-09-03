import assert from "node:assert/strict";
import test from "node:test";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { resolveOpportunityProfile } from "../src/opportunities/profiles.js";
import { reviewStoredOpportunities } from "../src/opportunities/review.js";
import type { OpportunityStore } from "../src/opportunities/store.js";

const NOW = "2026-08-27T14:00:00.000Z";

const rows: readonly OpportunityCandidate[] = [
  {
    id: "opp_candidate",
    source: "reddit_rss",
    externalId: "candidate",
    title: "[HIRING] Remote automation workflow",
    body: "Budget $150 per project. Need API integration and CRM automation.",
    observedAt: NOW,
    tags: ["reddit"],
    metadata: {},
  },
  {
    id: "opp_review",
    source: "reddit_rss",
    externalId: "review",
    title: "Project files question",
    body: "Could use advice on organizing a folder structure.",
    observedAt: "2026-08-27T13:59:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
  {
    id: "opp_reject",
    source: "reddit_rss",
    externalId: "reject",
    title: "[FOR HIRE] Automation developer",
    body: "Available for projects. Remote.",
    observedAt: "2026-08-27T13:58:00.000Z",
    tags: ["reddit"],
    metadata: {},
  },
];

const store: OpportunityStore = {
  async seenIds() {
    return new Set(rows.map((row) => row.id));
  },
  async saveMany() {
    throw new Error("review test store is read-only");
  },
  async list(limit = 500) {
    return rows.slice(0, limit);
  },
};

test("offline review can recover candidate/review items while excluding deterministic rejects", async () => {
  const profile = resolveOpportunityProfile("demand");
  const entries = await reviewStoredOpportunities(store, profile.triage, {
    decisions: ["candidate", "review"],
    limit: 100,
  });

  assert.deepEqual(
    entries.map((entry) => [entry.opportunity.id, entry.triage.decision]),
    [
      ["opp_candidate", "candidate"],
      ["opp_review", "review"],
    ],
  );
});

test("persisted opportunities can be re-triaged under a different profile without refetching", async () => {
  const all = await reviewStoredOpportunities(store, resolveOpportunityProfile("all").triage, {
    decisions: ["candidate", "review", "reject"],
  });
  const demand = await reviewStoredOpportunities(store, resolveOpportunityProfile("demand").triage, {
    decisions: ["candidate", "review", "reject"],
  });

  const sellerAll = all.find((entry) => entry.opportunity.id === "opp_reject");
  const sellerDemand = demand.find((entry) => entry.opportunity.id === "opp_reject");
  assert.ok(sellerAll !== undefined && sellerDemand !== undefined);
  assert.notEqual(sellerAll.triage.decision, "reject");
  assert.equal(sellerDemand.triage.decision, "reject");
});

test("offline review honors result limits after decision filtering", async () => {
  const entries = await reviewStoredOpportunities(store, resolveOpportunityProfile("demand").triage, {
    decisions: ["candidate", "review"],
    limit: 1,
    scanLimit: 3,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.opportunity.id, "opp_candidate");
});
