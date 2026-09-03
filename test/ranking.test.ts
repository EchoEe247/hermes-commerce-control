import test from "node:test";
import assert from "node:assert/strict";
import { dedupeServices, type MergedService } from "../src/aggregate/services.js";
import { rankServices, scoreService, SERVICE_WEIGHTS } from "../src/ranking/services.js";
import { rankWork, scoreWork, WORK_WEIGHTS } from "../src/ranking/work.js";
import { canonicalServiceId, canonicalWorkId } from "../src/core/ids.js";
import {
  modeAServiceActionability,
  modeAWorkActionability,
  type EvidenceClass,
  type FundingState,
  type PlatformId,
  type ServiceCandidate,
  type SourceHealth,
  type VerifierType,
  type WorkCandidate,
} from "../src/core/models.js";

const NOW = "2026-08-19T00:00:00.000Z";

function merged(overrides: {
  source?: PlatformId;
  resourceUrl?: string;
  network?: string | undefined;
  priceUsd?: string | undefined;
  health?: SourceHealth;
  observedAt?: string;
  calls30d?: number | undefined;
  sourceCount?: number;
  protocol?: string;
}): MergedService {
  const source = overrides.source ?? "cdp_bazaar";
  const resourceUrl = overrides.resourceUrl ?? "https://api.example.com/v1/a";
  const network = "network" in overrides ? overrides.network : "eip155:84532";
  const base: ServiceCandidate = {
    id: canonicalServiceId({
      resourceUrl,
      method: "POST",
      protocol: overrides.protocol ?? "x402",
      network,
      payTo: undefined,
    }),
    kind: "service",
    sources: [{ source, externalId: resourceUrl, observedAt: overrides.observedAt ?? NOW }],
    name: "svc",
    resourceUrl,
    method: "POST",
    protocol: overrides.protocol ?? "x402",
    ...(network === undefined ? {} : { network }),
    ...(overrides.priceUsd === undefined
      ? {}
      : { price: { decimal: overrides.priceUsd, usd: overrides.priceUsd, currency: "USDC" } }),
    health: overrides.health ?? "ok",
    observedAt: overrides.observedAt ?? NOW,
    ...(overrides.calls30d === undefined ? {} : { activity: { calls30d: overrides.calls30d } }),
    tags: [],
    evidence: [],
    actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
  };
  return Object.freeze({ ...base, sourceCount: overrides.sourceCount ?? 1 });
}

function workItem(overrides: {
  externalId: string;
  source?: PlatformId;
  verifier?: VerifierType;
  fundingState?: FundingState;
  fundingEvidence?: EvidenceClass;
  amount?: string;
  deadline?: string | undefined;
  requirements?: string[];
}): WorkCandidate {
  const source = overrides.source ?? "agent_bounties";
  return {
    id: canonicalWorkId({ source, externalId: overrides.externalId }),
    kind: "work",
    source,
    externalId: overrides.externalId,
    title: `work ${overrides.externalId}`,
    reward: { amount: overrides.amount ?? "5", asset: "USDC", usd: overrides.amount ?? "5" },
    funding: {
      state: overrides.fundingState ?? "funded",
      evidence: overrides.fundingEvidence ?? "observed",
    },
    verification: { type: overrides.verifier ?? "deterministic" },
    ...(overrides.deadline === undefined ? {} : { deadline: overrides.deadline }),
    requirements: overrides.requirements ?? [],
    status: "open",
    observedAt: NOW,
    evidence: [],
    actionability: modeAWorkActionability({ canPrepareClaim: true }),
  };
}

test("ranking: service weights are exactly the specified values totalling 100", () => {
  assert.deepEqual(SERVICE_WEIGHTS, {
    health: 25,
    priceFit: 20,
    freshness: 15,
    activity: 20,
    sourceConfidence: 10,
    networkFit: 10,
  });
  const total = Object.values(SERVICE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test("ranking: work weights are exactly the specified values totalling 100", () => {
  assert.deepEqual(WORK_WEIGHTS, {
    fundingProof: 25,
    verificationQuality: 20,
    rewardAttractiveness: 20,
    deadlineFeasibility: 15,
    requirementFit: 10,
    sourceConfidence: 10,
  });
  const total = Object.values(WORK_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test("ranking: no service component can exceed its weight", () => {
  const perfect = merged({ priceUsd: "0.000001", calls30d: 100000, sourceCount: 4 });
  const b = scoreService(perfect, { now: NOW, preferredNetwork: "eip155:84532", preferredProtocol: "x402" });
  assert.ok(b.health <= SERVICE_WEIGHTS.health);
  assert.ok(b.priceFit <= SERVICE_WEIGHTS.priceFit);
  assert.ok(b.freshness <= SERVICE_WEIGHTS.freshness);
  assert.ok(b.activity <= SERVICE_WEIGHTS.activity);
  assert.ok(b.sourceConfidence <= SERVICE_WEIGHTS.sourceConfidence);
  assert.ok(b.networkFit <= SERVICE_WEIGHTS.networkFit);
  assert.ok(b.total <= 100, `total ${String(b.total)} exceeded 100`);
});

test("ranking: unknown activity receives the neutral contribution, not zero", () => {
  const unknown = scoreService(merged({ calls30d: undefined }), { now: NOW });
  const zero = scoreService(merged({ calls30d: 0 }), { now: NOW });
  assert.equal(unknown.activity, SERVICE_WEIGHTS.activity * 0.5);
  assert.ok(unknown.neutralComponents.includes("activity"));
  assert.equal(zero.activity, 0, "an explicit zero really is zero");
  assert.ok(
    unknown.activity > zero.activity,
    "an unproven service must outrank a demonstrably unused one",
  );
});

test("ranking: unknown price is neutral and never assumed cheap", () => {
  const unknown = scoreService(merged({ priceUsd: undefined }), { now: NOW });
  const cheap = scoreService(merged({ priceUsd: "0.000001" }), { now: NOW });
  assert.equal(unknown.priceFit, SERVICE_WEIGHTS.priceFit * 0.5);
  assert.ok(unknown.neutralComponents.includes("priceFit"));
  assert.ok(cheap.priceFit > unknown.priceFit, "a known cheap price beats an unknown one");
});

test("ranking: a known price above the hard maximum is FILTERED, not penalized", () => {
  const cheap = merged({ resourceUrl: "https://api.example.com/v1/cheap", priceUsd: "0.02" });
  const expensive = merged({ resourceUrl: "https://api.example.com/v1/expensive", priceUsd: "5.00" });
  const ranked = rankServices([cheap, expensive], { maxUsdPrice: "1.00", now: NOW });
  assert.equal(ranked.length, 1, "over-budget service must be removed entirely");
  assert.equal(ranked[0]?.service.id, cheap.id);
});

test("ranking: an unknown price survives the price filter but stays marked unknown", () => {
  const unknown = merged({ resourceUrl: "https://api.example.com/v1/unknown", priceUsd: undefined });
  const ranked = rankServices([unknown], { maxUsdPrice: "1.00", now: NOW });
  assert.equal(ranked.length, 1, "unknown price is not silently excluded");
  assert.ok(ranked[0]?.breakdown.neutralComponents.includes("priceFit"));
});

test("ranking: health dominates as the largest single weight", () => {
  const healthy = merged({ resourceUrl: "https://api.example.com/v1/h", health: "ok" });
  const broken = merged({ resourceUrl: "https://api.example.com/v1/b", health: "unreachable" });
  const hs = scoreService(healthy, { now: NOW });
  const bs = scoreService(broken, { now: NOW });
  assert.equal(hs.health, 25);
  assert.equal(bs.health, 0);
  assert.ok(hs.total > bs.total);
});

test("ranking: freshness decays with observation age", () => {
  const fresh = scoreService(merged({ observedAt: NOW }), { now: NOW });
  const week = scoreService(merged({ observedAt: "2026-08-12T00:00:00.000Z" }), { now: NOW });
  const old = scoreService(merged({ observedAt: "2026-01-01T00:00:00.000Z" }), { now: NOW });
  assert.equal(fresh.freshness, SERVICE_WEIGHTS.freshness);
  assert.equal(old.freshness, 0, "beyond the horizon scores zero");
  assert.ok(week.freshness < fresh.freshness && week.freshness >= 0);
});

test("ranking: cross-source agreement raises source confidence but is capped", () => {
  const single = scoreService(merged({ sourceCount: 1 }), { now: NOW });
  const triple = scoreService(merged({ sourceCount: 3 }), { now: NOW });
  const many = scoreService(merged({ sourceCount: 99 }), { now: NOW });
  assert.ok(triple.sourceConfidence > single.sourceConfidence);
  assert.ok(many.sourceConfidence <= SERVICE_WEIGHTS.sourceConfidence);
});

test("ranking: a preferred network match beats a mismatch", () => {
  const match = merged({ resourceUrl: "https://api.example.com/v1/m", network: "eip155:84532" });
  const miss = merged({ resourceUrl: "https://api.example.com/v1/x", network: "eip155:1" });
  const ms = scoreService(match, { now: NOW, preferredNetwork: "eip155:84532" });
  const xs = scoreService(miss, { now: NOW, preferredNetwork: "eip155:84532" });
  assert.equal(ms.networkFit, SERVICE_WEIGHTS.networkFit);
  assert.equal(xs.networkFit, 0);
});

test("ranking: ties break on canonical ID lexical order", () => {
  // Two identical services differing only in URL, hence in canonical ID.
  const a = merged({ resourceUrl: "https://api.example.com/v1/aaa" });
  const b = merged({ resourceUrl: "https://api.example.com/v1/bbb" });
  const forward = rankServices([a, b], { now: NOW });
  const reverse = rankServices([b, a], { now: NOW });
  assert.equal(forward[0]?.score, forward[1]?.score, "scores should tie");
  assert.deepEqual(
    forward.map((r) => r.service.id),
    reverse.map((r) => r.service.id),
    "tie order must not depend on input order",
  );
  const ids = forward.map((r) => r.service.id);
  assert.deepEqual(ids, [...ids].sort(), "tied results are in lexical ID order");
});

test("ranking: every ranked service exposes its full breakdown", () => {
  const ranked = rankServices([merged({})], { now: NOW });
  const b = ranked[0]?.breakdown;
  assert.ok(b !== undefined);
  for (const key of [
    "health",
    "priceFit",
    "freshness",
    "activity",
    "sourceConfidence",
    "networkFit",
    "total",
    "neutralComponents",
  ]) {
    assert.ok(key in (b as object), `breakdown missing ${key}`);
  }
  const sum =
    (b?.health ?? 0) +
    (b?.priceFit ?? 0) +
    (b?.freshness ?? 0) +
    (b?.activity ?? 0) +
    (b?.sourceConfidence ?? 0) +
    (b?.networkFit ?? 0);
  assert.ok(Math.abs(sum - (b?.total ?? 0)) < 0.001, "components must sum to the total");
});

test("ranking: work funding proof scores on evidence class, not platform assertion", () => {
  const verified = scoreWork(workItem({ externalId: "v", fundingEvidence: "verified" }), { now: NOW });
  const observed = scoreWork(workItem({ externalId: "o", fundingEvidence: "observed" }), { now: NOW });
  const tentative = scoreWork(workItem({ externalId: "t", fundingEvidence: "tentative" }), { now: NOW });
  assert.equal(verified.fundingProof, WORK_WEIGHTS.fundingProof);
  assert.ok(observed.fundingProof < verified.fundingProof);
  assert.ok(tentative.fundingProof < observed.fundingProof);
});

test("ranking: a deterministic verifier outranks an opaque AI oracle when otherwise equal", () => {
  const deterministic = workItem({ externalId: "det", verifier: "deterministic" });
  const oracle = workItem({ externalId: "ai", verifier: "ai_oracle" });
  const ds = scoreWork(deterministic, { now: NOW });
  const os = scoreWork(oracle, { now: NOW });
  assert.equal(ds.verificationQuality, WORK_WEIGHTS.verificationQuality);
  assert.ok(
    ds.verificationQuality > os.verificationQuality,
    "predictable verification must beat an opaque oracle",
  );
  const ranked = rankWork([oracle, deterministic], { now: NOW });
  assert.equal(ranked[0]?.work.externalId, "det");
});

test("ranking: verifier ordering is deterministic > hybrid > operator > ai_oracle > unknown", () => {
  const order: VerifierType[] = ["deterministic", "hybrid", "operator", "ai_oracle", "unknown"];
  const scores = order.map(
    (verifier) => scoreWork(workItem({ externalId: verifier, verifier }), { now: NOW }).verificationQuality,
  );
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      (scores[i] as number) < (scores[i - 1] as number),
      `${order[i]} should score below ${order[i - 1]}`,
    );
  }
});

test("ranking: larger rewards score higher with diminishing returns", () => {
  const at = (amount: string): number =>
    scoreWork(workItem({ externalId: `r${amount}`, amount }), { now: NOW }).rewardAttractiveness;

  // Monotonic.
  assert.ok(at("1") < at("5"));
  assert.ok(at("5") < at("25"));

  // Diminishing returns is a statement about EQUAL ABSOLUTE increments: the same
  // extra $4 is worth more at the bottom of the range than near the top. (Equal
  // *ratios* would gain roughly equally under log scaling, so comparing 1->5
  // against 5->25 would not demonstrate the property.)
  const lowGain = at("5") - at("1");
  const highGain = at("25") - at("21");
  assert.ok(
    highGain < lowGain,
    `an extra $4 near the top (${String(highGain)}) must be worth less than at the bottom (${String(lowGain)})`,
  );
});

test("ranking: no deadline is full marks and an expired deadline is zero", () => {
  const none = scoreWork(workItem({ externalId: "n", deadline: undefined }), { now: NOW });
  const future = scoreWork(
    workItem({ externalId: "f", deadline: "2026-08-30T00:00:00.000Z" }),
    { now: NOW },
  );
  const past = scoreWork(
    workItem({ externalId: "p", deadline: "2026-08-01T00:00:00.000Z" }),
    { now: NOW },
  );
  assert.equal(none.deadlineFeasibility, WORK_WEIGHTS.deadlineFeasibility);
  assert.equal(future.deadlineFeasibility, WORK_WEIGHTS.deadlineFeasibility);
  assert.equal(past.deadlineFeasibility, 0, "an expired deadline is unusable");
});

test("ranking: requirement fit is neutral without declared capabilities", () => {
  const neutral = scoreWork(
    workItem({ externalId: "r", requirements: ["python", "regex"] }),
    { now: NOW },
  );
  assert.equal(neutral.requirementFit, WORK_WEIGHTS.requirementFit * 0.5);
  assert.ok(neutral.neutralComponents.includes("requirementFit"));

  const matched = scoreWork(
    workItem({ externalId: "r", requirements: ["python", "regex"] }),
    { now: NOW, capabilities: ["python", "regex"] },
  );
  assert.equal(matched.requirementFit, WORK_WEIGHTS.requirementFit);

  const mismatched = scoreWork(
    workItem({ externalId: "r", requirements: ["solidity"] }),
    { now: NOW, capabilities: ["python"] },
  );
  assert.equal(mismatched.requirementFit, 0);
});

test("ranking: a minimum reward filter excludes work below it", () => {
  const small = workItem({ externalId: "small", amount: "0.50" });
  const big = workItem({ externalId: "big", amount: "10" });
  const ranked = rankWork([small, big], { now: NOW, minReward: "1" });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.work.externalId, "big");
});

test("ranking: work ties break on canonical ID lexical order", () => {
  const a = workItem({ externalId: "aaa" });
  const b = workItem({ externalId: "bbb" });
  const forward = rankWork([a, b], { now: NOW });
  const reverse = rankWork([b, a], { now: NOW });
  assert.equal(forward[0]?.score, forward[1]?.score);
  assert.deepEqual(
    forward.map((r) => r.work.id),
    reverse.map((r) => r.work.id),
  );
  const ids = forward.map((r) => r.work.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("ranking: no work component can exceed its weight and the total stays within 100", () => {
  const best = workItem({
    externalId: "best",
    fundingEvidence: "verified",
    verifier: "deterministic",
    amount: "1000",
    deadline: undefined,
  });
  const b = scoreWork(best, { now: NOW, capabilities: ["work"] });
  assert.ok(b.fundingProof <= WORK_WEIGHTS.fundingProof);
  assert.ok(b.verificationQuality <= WORK_WEIGHTS.verificationQuality);
  assert.ok(b.rewardAttractiveness <= WORK_WEIGHTS.rewardAttractiveness);
  assert.ok(b.deadlineFeasibility <= WORK_WEIGHTS.deadlineFeasibility);
  assert.ok(b.requirementFit <= WORK_WEIGHTS.requirementFit);
  assert.ok(b.sourceConfidence <= WORK_WEIGHTS.sourceConfidence);
  assert.ok(b.total <= 100);
});

test("ranking: ranking runs after aggregation, on merged services", () => {
  // A service seen twice should be ranked once, with its merged source count.
  const a = merged({ source: "cdp_bazaar", sourceCount: 1 });
  const dedup = dedupeServices([a, { ...a, sources: [{ source: "agent402", externalId: "x", observedAt: NOW }] }]);
  const ranked = rankServices(dedup, { now: NOW });
  assert.equal(ranked.length, 1, "a duplicate must not be ranked twice");
  assert.equal(ranked[0]?.service.sourceCount, 2);
});

test("ranking: no LLM or randomness is used", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/ranking/services.ts", "../src/ranking/work.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("Math.random"), false, `${file} must be deterministic`);
    assert.equal(/openai|anthropic|llm|gpt|claude/i.test(source), false, `${file} must not use an LLM`);
    // Date.now may only be reached through an injected option default.
    assert.equal(source.includes("Date.now()"), false, `${file} must take time as a parameter`);
  }
});
