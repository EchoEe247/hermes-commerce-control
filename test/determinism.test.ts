import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/core/ids.js";
import { dedupeServices } from "../src/aggregate/services.js";
import { aggregateWork } from "../src/aggregate/work.js";
import { rankServices } from "../src/ranking/services.js";
import { rankWork } from "../src/ranking/work.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { normalizeBazaarItem } from "../src/adapters/cdp-bazaar/index.js";
import { normalizePipRailResource } from "../src/adapters/piprail/index.js";
import { normalizeThe402Service } from "../src/adapters/the402/index.js";
import { normalizeBounty } from "../src/adapters/agent-bounties/index.js";
import { normalizeJob } from "../src/adapters/bountybook/index.js";
import { loadConfig } from "../src/config.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { PlatformId, ServiceCandidate, WorkCandidate } from "../src/core/models.js";
import {
  BROWSE_RESPONSE,
  DUPLICATE_RESOURCE,
  SEPOLIA_RESOURCE,
  VALID_RESOURCE,
} from "./fixtures/cdp-bazaar/responses.js";
import { DISCOVER_RESULTS } from "./fixtures/piprail/responses.js";
import { CATALOG_RESPONSE } from "./fixtures/the402/responses.js";
import { INVENTORY_SUMMARY } from "./fixtures/agent-bounties/responses.js";
import { OPEN_JOBS } from "./fixtures/bountybook/responses.js";

const cfg = loadConfig({});
/** Frozen clock: determinism must not depend on wall time. */
const FIXED_NOW = "2026-08-19T00:00:00.000Z";
const CLOCK = (): string => FIXED_NOW;

/** Context with no network: normalization must be pure over fixtures. */
function ctx(platform: PlatformId): AdapterContext {
  return {
    fetch: {
      json: async () => {
        throw new Error("determinism fixtures must not touch the network");
      },
      text: async () => {
        throw new Error("determinism fixtures must not touch the network");
      },
    },
    evidence: new EvidenceCollector(platform, CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

/**
 * The canonical pipeline under test: normalize every fixture through its real
 * adapter normalizer, aggregate, dedupe, then rank. This is the whole
 * deterministic path a reviewer cares about.
 */
function runPipeline(): { services: unknown; work: unknown } {
  const services: ServiceCandidate[] = [];

  // CDP Bazaar, including a deliberate cross-source duplicate.
  for (const item of [...BROWSE_RESPONSE.items, VALID_RESOURCE, DUPLICATE_RESOURCE, SEPOLIA_RESOURCE]) {
    const candidate = normalizeBazaarItem(item, ctx("cdp_bazaar"), "https://fixture/bazaar");
    if (candidate !== null) services.push(candidate);
  }

  // PipRail: overlaps the Sepolia profiler resource.
  for (const entry of DISCOVER_RESULTS) {
    const candidate = normalizePipRailResource(entry, ctx("piprail"), "piprail:discover");
    if (candidate !== null) services.push(candidate);
  }

  // the402.
  for (const entry of CATALOG_RESPONSE.services) {
    const candidate = normalizeThe402Service(entry, ctx("the402"), "https://fixture/the402");
    if (candidate !== null) services.push(candidate);
  }

  const work: WorkCandidate[] = [];
  for (const item of INVENTORY_SUMMARY.items) {
    const candidate = normalizeBounty(
      item,
      ctx("agent_bounties"),
      "https://fixture/bounties",
      "base-mainnet",
    );
    if (candidate !== null) work.push(candidate);
  }
  for (const job of OPEN_JOBS.jobs) {
    const candidate = normalizeJob(job, ctx("bountybook"), "https://fixture/bountybook");
    if (candidate !== null) work.push(candidate);
  }

  const rankedServices = rankServices(dedupeServices(services), {
    now: FIXED_NOW,
    maxUsdPrice: "10.00",
    preferredNetwork: "eip155:84532",
    preferredProtocol: "x402",
  });
  const rankedWork = rankWork(aggregateWork(work), {
    now: FIXED_NOW,
    capabilities: ["python", "data"],
    minReward: "0.10",
  });

  return { services: rankedServices, work: rankedWork };
}

test("determinism: 20 runs of the canonical pipeline yield exactly one hash", () => {
  const hashes = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    hashes.add(sha256Hex(canonicalJson(runPipeline())));
  }
  assert.equal(
    hashes.size,
    1,
    `expected a single canonical hash across 20 runs, got ${String(hashes.size)}: ${[...hashes].join(", ")}`,
  );
});

test("determinism: the pipeline produces a non-trivial result", () => {
  // A hash of nothing is trivially stable, so prove there is real content.
  const { services, work } = runPipeline();
  assert.ok(Array.isArray(services) && services.length >= 5, "expected several ranked services");
  assert.ok(Array.isArray(work) && work.length >= 3, "expected several ranked work items");
});

test("determinism: ranking output is independent of input order", () => {
  const first = runPipeline();
  const firstHash = sha256Hex(canonicalJson(first));

  // Re-run with the service list reversed before aggregation by rebuilding the
  // pipeline through the public helpers.
  const services: ServiceCandidate[] = [];
  for (const item of [...BROWSE_RESPONSE.items].reverse()) {
    const candidate = normalizeBazaarItem(item, ctx("cdp_bazaar"), "https://fixture/bazaar");
    if (candidate !== null) services.push(candidate);
  }
  const forward = rankServices(dedupeServices(services), { now: FIXED_NOW });
  const reverse = rankServices(dedupeServices([...services].reverse()), { now: FIXED_NOW });
  assert.equal(sha256Hex(canonicalJson(forward)), sha256Hex(canonicalJson(reverse)));
  assert.equal(typeof firstHash, "string");
});

test("determinism: canonical JSON is key-order independent at every depth", () => {
  const a = { z: 1, a: { d: [1, { y: 2, x: 3 }], c: 4 } };
  const b = { a: { c: 4, d: [1, { x: 3, y: 2 }] }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});

test("determinism: scores are stable to 4 decimal places", () => {
  const runs = Array.from({ length: 20 }, () => runPipeline());
  const totals = runs.map((r) =>
    (r.services as Array<{ score: number }>).map((s) => s.score).join(","),
  );
  assert.equal(new Set(totals).size, 1, "score vectors must be identical across runs");
});

test("determinism: the pipeline never emits a live-action flag", () => {
  const { services, work } = runPipeline();
  for (const entry of services as Array<{ service: { actionability: Record<string, unknown> } }>) {
    assert.equal(entry.service.actionability.canPurchase, false);
  }
  for (const entry of work as Array<{ work: { actionability: Record<string, unknown> } }>) {
    assert.equal(entry.work.actionability.canClaim, false);
    assert.equal(entry.work.actionability.canSubmit, false);
  }
});

test("determinism: the cross-source duplicate collapsed", () => {
  const { services } = runPipeline();
  const ids = (services as Array<{ service: { id: string } }>).map((s) => s.service.id);
  assert.equal(new Set(ids).size, ids.length, "ranked output must contain no duplicate IDs");
  // The Sepolia profiler resource is present in both the CDP and PipRail
  // fixtures, so at least one merged result should carry two sources.
  const multi = (services as Array<{ service: { sourceCount: number } }>).filter(
    (s) => s.service.sourceCount > 1,
  );
  assert.ok(multi.length >= 1, "expected at least one cross-source merge");
});
