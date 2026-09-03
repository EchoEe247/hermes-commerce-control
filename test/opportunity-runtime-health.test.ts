import assert from "node:assert/strict";
import test from "node:test";
import type { OpportunitySourceStatus } from "../src/opportunities/models.js";
import { summarizeOpportunitySourceHealth } from "../src/opportunities/runtime-health.js";

function status(
  value: OpportunitySourceStatus["status"],
  count = 0,
): OpportunitySourceStatus {
  return {
    status: value,
    count,
    durationMs: 10,
    ...(value === "ok" ? {} : { error: `${value} fixture` }),
  };
}

test("empty but reachable source is healthy independently of result count", () => {
  const summary = summarizeOpportunitySourceHealth({ reddit_rss: status("ok", 0) });
  assert.equal(summary.ok, true);
  assert.equal(summary.degraded, false);
  assert.deepEqual(summary.healthySources, ["reddit_rss"]);
  assert.deepEqual(summary.failedSources, []);
});

test("unreachable-only watcher is failed rather than a healthy empty pass", () => {
  const summary = summarizeOpportunitySourceHealth({ reddit_rss: status("unreachable") });
  assert.equal(summary.ok, false);
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.healthySources, []);
  assert.deepEqual(summary.failedSources, ["reddit_rss"]);
});

test("multi-source watcher stays usable but reports degraded when one source succeeds", () => {
  const summary = summarizeOpportunitySourceHealth({
    reddit_rss: status("ok", 3),
    redditapis_monitor: status("degraded"),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.healthySources, ["reddit_rss"]);
  assert.deepEqual(summary.failedSources, ["redditapis_monitor"]);
});

test("no configured source is not considered healthy", () => {
  const summary = summarizeOpportunitySourceHealth({});
  assert.equal(summary.ok, false);
  assert.equal(summary.degraded, false);
});
