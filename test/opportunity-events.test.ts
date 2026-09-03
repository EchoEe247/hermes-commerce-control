import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommerceError } from "../src/core/errors.js";
import {
  normalizeAndPersistEvent,
  type OpportunityEventNormalizer,
} from "../src/opportunities/events.js";
import { canonicalOpportunityId, type OpportunityCandidate } from "../src/opportunities/models.js";
import { JsonlOpportunityStore } from "../src/opportunities/store.js";

const NOW = "2026-08-27T13:00:00.000Z";

const normalizer: OpportunityEventNormalizer = {
  id: "redditapis_monitor",
  normalize(payload, context) {
    const raw = payload as { id: string; title: string; url: string };
    return [
      {
        id: canonicalOpportunityId({
          source: "redditapis_monitor",
          externalId: raw.id,
          url: raw.url,
        }),
        source: "redditapis_monitor",
        externalId: raw.id,
        title: raw.title,
        url: raw.url,
        observedAt: context.clock(),
        tags: ["reddit"],
        metadata: { delivery: "verified-upstream" },
      },
    ];
  },
};

test("push event seam persists a verified normalized event once", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-event-"));
  try {
    const store = new JsonlOpportunityStore(join(root, "opportunities.jsonl"));
    const payload = {
      id: "t3_webhook",
      title: "[Hiring] Remote automation task",
      url: "https://www.reddit.com/r/forhire/comments/webhook/automation/",
    };

    const first = await normalizeAndPersistEvent(normalizer, payload, store, () => NOW);
    assert.equal(first.source, "redditapis_monitor");
    assert.equal(first.normalized, 1);
    assert.equal(first.results.length, 1);
    assert.equal(first.persisted, 1);
    assert.equal(first.duplicatesDropped, 0);
    assert.equal(first.results[0]?.observedAt, NOW);

    const second = await normalizeAndPersistEvent(normalizer, payload, store, () => NOW);
    assert.equal(second.normalized, 1);
    assert.equal(second.results.length, 0);
    assert.equal(second.persisted, 0);
    assert.equal(second.duplicatesDropped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push event identity collapses against an RSS-origin listing with the same URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-event-cross-source-"));
  try {
    const store = new JsonlOpportunityStore(join(root, "opportunities.jsonl"));
    const url = "https://www.reddit.com/r/forhire/comments/same/listing/";
    await store.saveMany([
      {
        id: canonicalOpportunityId({ source: "reddit_rss", externalId: "t3_same", url }),
        source: "reddit_rss",
        externalId: "t3_same",
        title: "RSS copy",
        url,
        observedAt: NOW,
        tags: ["reddit"],
        metadata: {},
      },
    ]);

    const result = await normalizeAndPersistEvent(
      normalizer,
      { id: "provider-specific-id", title: "Webhook copy", url },
      store,
      () => NOW,
    );
    assert.equal(result.results.length, 0);
    assert.equal(result.duplicatesDropped, 1);
    assert.equal(result.persisted, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push event seam rejects malformed normalized candidates before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-event-invalid-"));
  try {
    const store = new JsonlOpportunityStore(join(root, "opportunities.jsonl"));
    const malformed: OpportunityEventNormalizer = {
      id: "redditapis_monitor",
      normalize() {
        return [
          {
            id: "opp_bad",
            source: "redditapis_monitor",
            externalId: "bad",
            title: "bad",
            observedAt: NOW,
            tags: ["reddit"],
            metadata: { nested: 123 },
          } as unknown as OpportunityCandidate,
        ];
      },
    };

    await assert.rejects(
      normalizeAndPersistEvent(malformed, {}, store, () => NOW),
      (error: unknown) => error instanceof CommerceError && error.code === "SCHEMA_VIOLATION",
    );
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push event seam rejects candidates attributed to a different source", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-event-provenance-"));
  try {
    const store = new JsonlOpportunityStore(join(root, "opportunities.jsonl"));
    const mismatched: OpportunityEventNormalizer = {
      id: "redditapis_monitor",
      normalize() {
        return [
          {
            id: "opp_wrong_source",
            source: "reddit_rss",
            externalId: "wrong-source",
            title: "[HIRING] Wrongly attributed event",
            observedAt: NOW,
            tags: ["reddit"],
            metadata: {},
          },
        ];
      },
    };

    await assert.rejects(
      normalizeAndPersistEvent(mismatched, {}, store, () => NOW),
      (error: unknown) =>
        error instanceof CommerceError &&
        error.code === "SCHEMA_VIOLATION" &&
        /emitted candidate source reddit_rss/i.test(error.message),
    );
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
