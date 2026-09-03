import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommerceError } from "../src/core/errors.js";
import { dedupeOpportunities } from "../src/opportunities/dedupe.js";
import { OpportunityIngestor } from "../src/opportunities/ingest.js";
import {
  canonicalOpportunityId,
  parseOpportunityCandidate,
  type OpportunityCandidate,
} from "../src/opportunities/models.js";
import { discoverAndPersist } from "../src/opportunities/pipeline.js";
import type { OpportunitySourceAdapter } from "../src/opportunities/adapters/interface.js";
import {
  buildRedditAtomUrl,
  parseRedditAtom,
  RedditRssOpportunityAdapter,
} from "../src/opportunities/adapters/reddit-rss.js";
import { JsonlOpportunityStore } from "../src/opportunities/store.js";

const NOW = "2026-08-27T12:00:00.000Z";
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <author><name>/u/example_worker</name><uri>https://www.reddit.com/user/example_worker</uri></author>
    <category term="forhire" label="r/forhire"/>
    <content type="html">&lt;div&gt;&lt;p&gt;Need an &lt;strong&gt;automation&lt;/strong&gt; workflow built.&lt;/p&gt;&lt;/div&gt;</content>
    <id>t3_example1</id>
    <link href="https://www.reddit.com/r/forhire/comments/example1/need_automation/" />
    <published>2026-08-27T11:30:00+00:00</published>
    <title>[Hiring] Build &amp; document an automation workflow</title>
  </entry>
  <entry>
    <author><name>/u/local_only</name></author>
    <category term="slavelabour" label="r/slavelabour"/>
    <content type="html">&lt;p&gt;Physical pickup in Austin.&lt;/p&gt;</content>
    <id>t3_example2</id>
    <link href="https://www.reddit.com/r/slavelabour/comments/example2/local_pickup/"/>
    <updated>2026-08-27T11:40:00Z</updated>
    <title>[Task] Local pickup</title>
  </entry>
</feed>`;

const ESCAPED_LITERAL_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <category term="forhire" label="r/forhire"/>
    <content type="html">&lt;p&gt;Need parser support for &amp;lt;T&amp;gt; inside HTML.&lt;/p&gt;</content>
    <id>t3_literal</id>
    <link href="https://www.reddit.com/r/forhire/comments/literal/parser/" />
    <published>2026-08-27T11:45:00Z</published>
    <title>[HIRING] C++ vector&lt;T&gt; parser</title>
  </entry>
</feed>`;

test("buildRedditAtomUrl combines selected subreddits on the permanent-free RSS path", () => {
  const url = new URL(buildRedditAtomUrl(["r/forhire", "slavelabour", "forhire"]));
  assert.equal(url.origin, "https://www.reddit.com");
  assert.equal(url.pathname, "/r/forhire+slavelabour/new/.rss");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.throws(() => buildRedditAtomUrl(["bad/name"]), /invalid subreddit/i);
});

test("parseRedditAtom produces clean provider-independent opportunities", () => {
  const feedUrl = buildRedditAtomUrl(["forhire", "slavelabour"]);
  const parsed = parseRedditAtom(FEED, { observedAt: NOW, feedUrl });
  assert.equal(parsed.length, 2);

  const first = parsed[0];
  assert.ok(first !== undefined);
  assert.equal(first.source, "reddit_rss");
  assert.equal(first.externalId, "t3_example1");
  assert.equal(first.community, "forhire");
  assert.equal(first.author, "/u/example_worker");
  assert.equal(first.title, "[Hiring] Build & document an automation workflow");
  assert.equal(first.body, "Need an automation workflow built.");
  assert.equal(first.postedAt, "2026-08-27T11:30:00.000Z");
  assert.equal(first.observedAt, NOW);
  assert.deepEqual(first.tags, ["reddit", "r/forhire"]);
  assert.equal(first.metadata.feedUrl, feedUrl);
});

test("Atom plain text preserves escaped angle-bracket literals while HTML markup is stripped", () => {
  const feedUrl = buildRedditAtomUrl(["forhire"]);
  const parsed = parseRedditAtom(ESCAPED_LITERAL_FEED, { observedAt: NOW, feedUrl });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, "[HIRING] C++ vector<T> parser");
  assert.equal(parsed[0]?.body, "Need parser support for <T> inside HTML.");
});

test("canonical opportunity IDs dedupe the same listing across providers", () => {
  const url = "https://www.reddit.com/r/forhire/comments/example1/need_automation/";
  const base: OpportunityCandidate = {
    id: canonicalOpportunityId({ source: "reddit_rss", externalId: "t3_example1", url }),
    source: "reddit_rss",
    externalId: "t3_example1",
    title: "one",
    url,
    observedAt: NOW,
    tags: [],
    metadata: {},
  };
  const webhook: OpportunityCandidate = {
    ...base,
    id: canonicalOpportunityId({ source: "redditapis_monitor", externalId: "different-id", url }),
    source: "redditapis_monitor",
    externalId: "different-id",
    title: "same listing from webhook",
  };

  assert.equal(base.id, webhook.id);
  const result = dedupeOpportunities([base, webhook]);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("runtime candidate schema rejects malformed source metadata", () => {
  assert.throws(
    () =>
      parseOpportunityCandidate({
        id: "opp_bad",
        source: "reddit_rss",
        externalId: "t3_bad",
        title: "bad",
        observedAt: NOW,
        tags: ["reddit"],
        metadata: { nested: { unexpected: true } },
      }),
    (error: unknown) => error instanceof CommerceError && error.code === "SCHEMA_VIOLATION",
  );
});

test("Reddit RSS adapter filters locally after one feed read", async () => {
  const requested: string[] = [];
  const adapter = new RedditRssOpportunityAdapter({ subreddits: ["forhire", "slavelabour"] });
  const result = await adapter.discover(
    { q: "automation", limit: 10 },
    {
      clock: () => NOW,
      signal: new AbortController().signal,
      fetch: {
        text: async (url) => {
          requested.push(url);
          return { status: 200, url, headers: {}, bytes: FEED.length, text: FEED };
        },
      },
    },
  );

  assert.equal(requested.length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.externalId, "t3_example1");
});

test("ingestor isolates a malformed source instead of poisoning good results", async () => {
  const bad: OpportunitySourceAdapter = {
    id: "generic_rss",
    async discover() {
      return [
        {
          id: "opp_bad",
          source: "generic_rss",
          externalId: "bad",
          title: "bad",
          observedAt: NOW,
          tags: [],
          metadata: { invalid: 123 },
        } as unknown as OpportunityCandidate,
      ];
    },
  };
  const good = new RedditRssOpportunityAdapter({ subreddits: ["forhire", "slavelabour"] });
  const ingestor = new OpportunityIngestor(
    {
      text: async (url) => ({ status: 200, url, headers: {}, bytes: FEED.length, text: FEED }),
    },
    [bad, good],
    { clock: () => NOW, adapterBudgetMs: 2_000 },
  );

  const result = await ingestor.discover();
  assert.equal(result.sources.generic_rss?.status, "degraded");
  assert.equal(result.sources.reddit_rss?.status, "ok");
  assert.equal(result.results.length, 2);
});

test("pipeline persists fresh opportunities and drops them on the next pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-opportunities-"));
  try {
    const storePath = join(root, "opportunities.jsonl");
    const store = new JsonlOpportunityStore(storePath);
    const adapter = new RedditRssOpportunityAdapter({ subreddits: ["forhire", "slavelabour"] });
    const ingestor = new OpportunityIngestor(
      {
        text: async (url) => ({ status: 200, url, headers: {}, bytes: FEED.length, text: FEED }),
      },
      [adapter],
      { clock: () => NOW, adapterBudgetMs: 2_000 },
    );

    const first = await discoverAndPersist(ingestor, store);
    assert.equal(first.results.length, 2);
    assert.equal(first.persisted, 2);
    assert.equal(first.duplicatesDropped, 0);

    const second = await discoverAndPersist(ingestor, store);
    assert.equal(second.results.length, 0);
    assert.equal(second.persisted, 0);
    assert.equal(second.duplicatesDropped, 2);

    const stored = await store.list();
    assert.equal(stored.length, 2);
    const raw = await readFile(storePath, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL store repairs an invalid truncated tail before appending a fresh record", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-opportunity-tail-"));
  try {
    const storePath = join(root, "opportunities.jsonl");
    await writeFile(storePath, '{"id":"partial"', "utf8");
    const store = new JsonlOpportunityStore(storePath);
    const [candidate] = parseRedditAtom(FEED, {
      observedAt: NOW,
      feedUrl: buildRedditAtomUrl(["forhire", "slavelabour"]),
    });
    assert.ok(candidate !== undefined);

    assert.equal(await store.saveMany([candidate]), 1);
    const stored = await store.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, candidate.id);
    const raw = await readFile(storePath, "utf8");
    assert.equal(raw.trim().split("\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL store preserves a complete final record missing only its newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "commerce-opportunity-tail-complete-"));
  try {
    const storePath = join(root, "opportunities.jsonl");
    const parsed = parseRedditAtom(FEED, {
      observedAt: NOW,
      feedUrl: buildRedditAtomUrl(["forhire", "slavelabour"]),
    });
    const first = parsed[0];
    const second = parsed[1];
    assert.ok(first !== undefined && second !== undefined);
    await writeFile(storePath, JSON.stringify(first), "utf8");
    const store = new JsonlOpportunityStore(storePath);

    assert.equal(await store.saveMany([second]), 1);
    const stored = await store.list();
    assert.equal(stored.length, 2);
    assert.deepEqual(new Set(stored.map((row) => row.id)), new Set([first.id, second.id]));
    const raw = await readFile(storePath, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
