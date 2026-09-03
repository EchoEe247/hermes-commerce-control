import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpportunitySourceAdapter } from "../src/opportunities/adapters/interface.js";
import { OpportunityIngestor } from "../src/opportunities/ingest.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { JsonlOpportunityStore } from "../src/opportunities/store.js";

const NOW = "2026-08-27T13:45:00.000Z";

function candidate(id = "opp_same"): OpportunityCandidate {
  return {
    id,
    source: "reddit_rss",
    externalId: "t3_same",
    title: "[HIRING] Remote automation task",
    observedAt: NOW,
    tags: ["reddit"],
    metadata: {},
  };
}

test("pull adapter cannot emit a candidate attributed to another source", async () => {
  const mismatched: OpportunitySourceAdapter = {
    id: "generic_rss",
    async discover() {
      return [candidate()];
    },
  };
  const ingestor = new OpportunityIngestor(
    {
      text: async (url) => ({ status: 200, url, headers: {}, bytes: 0, text: "" }),
    },
    [mismatched],
    { clock: () => NOW, adapterBudgetMs: 2_000 },
  );

  const result = await ingestor.discover();
  assert.equal(result.results.length, 0);
  assert.equal(result.sources.generic_rss?.status, "degraded");
  assert.match(result.sources.generic_rss?.error ?? "", /emitted candidate source reddit_rss/i);
});

test("JSONL store deduplicates repeated IDs within one direct save batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-store-batch-dedupe-"));
  try {
    const store = new JsonlOpportunityStore(join(root, "opportunities.jsonl"));
    const first = candidate();
    const duplicate = { ...first, title: "duplicate representation" };

    assert.equal(await store.saveMany([first, duplicate]), 1);
    const stored = await store.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, first.id);
    assert.equal(stored[0]?.title, first.title);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
