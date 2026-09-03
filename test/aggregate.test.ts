import test from "node:test";
import assert from "node:assert/strict";
import { dedupeServices } from "../src/aggregate/services.js";
import { aggregateWork, dedupeWork, filterEarnableWork } from "../src/aggregate/work.js";
import { canonicalServiceId, canonicalWorkId } from "../src/core/ids.js";
import {
  modeAServiceActionability,
  modeAWorkActionability,
  type EvidenceClass,
  type FundingState,
  type PlatformId,
  type ServiceCandidate,
  type SourceHealth,
  type WorkCandidate,
  type WorkStatus,
} from "../src/core/models.js";
import { hashCanonical } from "../src/evidence/hashing.js";

const RESOURCE = "https://api.example.com/v1/profile";
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";

function service(overrides: {
  source: PlatformId;
  externalId?: string;
  resourceUrl?: string;
  method?: string;
  protocol?: string;
  network?: string | undefined;
  payTo?: string | undefined;
  priceDecimal?: string | undefined;
  health?: SourceHealth;
  observedAt?: string;
  calls30d?: number | undefined;
  tags?: string[];
  evidenceValue?: string;
}): ServiceCandidate {
  const resourceUrl = overrides.resourceUrl ?? RESOURCE;
  const method = overrides.method ?? "POST";
  const protocol = overrides.protocol ?? "x402";
  const network = "network" in overrides ? overrides.network : "eip155:84532";
  const payTo = "payTo" in overrides ? overrides.payTo : PAY_TO;
  const observedAt = overrides.observedAt ?? "2026-08-19T00:00:00.000Z";

  const id = canonicalServiceId({ resourceUrl, method, protocol, network, payTo });
  const evidence = [
    {
      platform: overrides.source,
      fact: "resource",
      value: overrides.evidenceValue ?? resourceUrl,
      classification: "observed" as EvidenceClass,
      sourceType: "http_api" as const,
      sourceRef: "https://x/y",
      capturedAt: observedAt,
      hash: hashCanonical({ s: overrides.source, r: resourceUrl, v: overrides.evidenceValue }),
    },
  ];

  return {
    id,
    kind: "service",
    sources: [
      {
        source: overrides.source,
        externalId: overrides.externalId ?? resourceUrl,
        observedAt,
      },
    ],
    name: `svc via ${overrides.source}`,
    resourceUrl,
    method,
    protocol,
    ...(network === undefined ? {} : { network }),
    ...(payTo === undefined ? {} : { payTo }),
    ...(overrides.priceDecimal === undefined
      ? {}
      : {
          price: {
            decimal: overrides.priceDecimal,
            usd: overrides.priceDecimal,
            currency: "USDC",
            display: `$${overrides.priceDecimal}`,
          },
        }),
    health: overrides.health ?? "ok",
    observedAt,
    ...(overrides.calls30d === undefined ? {} : { activity: { calls30d: overrides.calls30d } }),
    tags: overrides.tags ?? [],
    evidence,
    actionability: modeAServiceActionability({
      canQuote: overrides.priceDecimal !== undefined,
      canPreparePurchase: true,
    }),
  };
}

function work(overrides: {
  source: PlatformId;
  externalId: string;
  status?: WorkStatus;
  fundingState?: FundingState;
  fundingEvidence?: EvidenceClass;
  amount?: string;
}): WorkCandidate {
  return {
    id: canonicalWorkId({ source: overrides.source, externalId: overrides.externalId }),
    kind: "work",
    source: overrides.source,
    externalId: overrides.externalId,
    title: `work ${overrides.externalId}`,
    reward: { amount: overrides.amount ?? "1", asset: "USDC", usd: overrides.amount ?? "1" },
    funding: {
      state: overrides.fundingState ?? "funded",
      evidence: overrides.fundingEvidence ?? "observed",
    },
    verification: { type: "deterministic" },
    requirements: [],
    status: overrides.status ?? "open",
    observedAt: "2026-08-19T00:00:00.000Z",
    evidence: [],
    actionability: modeAWorkActionability({ canPrepareClaim: true }),
  };
}

test("aggregate: the same service from three catalogues collapses to one result", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", externalId: "cdp-1" }),
    service({ source: "agent402", externalId: "a402-1" }),
    service({ source: "piprail", externalId: "pip-1" }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.sourceCount, 3);
  assert.deepEqual(
    merged[0]?.sources.map((s) => s.source),
    ["agent402", "cdp_bazaar", "piprail"],
    "all source observations are preserved in deterministic order",
  );
});

test("aggregate: a method difference does not merge", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", method: "POST" }),
    service({ source: "agent402", method: "GET" }),
  ]);
  assert.equal(merged.length, 2, "POST and GET are different services");
});

test("aggregate: a network difference does not merge", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", network: "eip155:84532" }),
    service({ source: "agent402", network: "eip155:8453" }),
  ]);
  assert.equal(merged.length, 2, "testnet and mainnet are different services");
});

test("aggregate: protocol and payTo differences do not merge", () => {
  assert.equal(
    dedupeServices([
      service({ source: "cdp_bazaar", protocol: "x402" }),
      service({ source: "the402", protocol: "the402" }),
    ]).length,
    2,
  );
  assert.equal(
    dedupeServices([
      service({ source: "cdp_bazaar", payTo: PAY_TO }),
      service({ source: "agent402", payTo: "0x0000000000000000000000000000000000000002" }),
    ]).length,
    2,
  );
});

test("aggregate: cosmetic URL differences DO merge", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", resourceUrl: "https://api.example.com/v1/profile" }),
    service({ source: "agent402", resourceUrl: "HTTPS://API.Example.COM:443/v1/profile" }),
  ]);
  assert.equal(merged.length, 1, "host case and :443 must not split identity");
});

test("aggregate: merge is independent of input order", () => {
  const a = service({ source: "cdp_bazaar", externalId: "cdp-1", priceDecimal: "0.02" });
  const b = service({ source: "agent402", externalId: "a402-1", priceDecimal: "0.03" });
  const c = service({ source: "piprail", externalId: "pip-1", priceDecimal: "0.01" });

  const forward = dedupeServices([a, b, c]);
  const reverse = dedupeServices([c, b, a]);
  const shuffled = dedupeServices([b, a, c]);

  assert.equal(hashCanonical(forward), hashCanonical(reverse));
  assert.equal(hashCanonical(forward), hashCanonical(shuffled));
});

test("aggregate: conflicting prices take the lowest and are flagged", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", priceDecimal: "0.05" }),
    service({ source: "agent402", priceDecimal: "0.02" }),
  ]);
  assert.equal(merged[0]?.price?.decimal, "0.02", "lowest trustworthy price wins");
  assert.match(
    String(merged[0]?.description),
    /differing prices/,
    "a genuine price conflict should be surfaced",
  );
});

test("aggregate: conflicting health takes the most pessimistic", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", health: "ok" }),
    service({ source: "the402", health: "degraded" }),
  ]);
  assert.equal(
    merged[0]?.health,
    "degraded",
    "one catalogue reporting a fault must not be masked by another",
  );
});

test("aggregate: a stale observation does not overwrite a fresher one as primary", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", observedAt: "2026-08-01T00:00:00.000Z", tags: ["stale"] }),
    service({ source: "agent402", observedAt: "2026-08-19T00:00:00.000Z", tags: ["fresh"] }),
  ]);
  assert.equal(merged[0]?.observedAt, "2026-08-19T00:00:00.000Z");
  // Tags are a union, so both survive.
  assert.deepEqual(merged[0]?.tags, ["fresh", "stale"]);
});

test("aggregate: activity takes the maximum because absence is unknown not zero", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", calls30d: 900 }),
    service({ source: "agent402", calls30d: undefined }),
  ]);
  assert.equal(merged[0]?.activity?.calls30d, 900);
});

test("aggregate: evidence is a hash-deduplicated union", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", evidenceValue: "same" }),
    service({ source: "cdp_bazaar", externalId: "other", evidenceValue: "same" }),
    service({ source: "agent402", evidenceValue: "different" }),
  ]);
  assert.equal(merged.length, 1);
  const hashes = merged[0]?.evidence.map((e) => e.hash) ?? [];
  assert.equal(new Set(hashes).size, hashes.length, "no duplicate evidence hashes");
  assert.equal(hashes.length, 2, "identical evidence collapses, distinct evidence is kept");
});

test("aggregate: merging never upgrades an evidence classification", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar" }),
    service({ source: "agent402" }),
    service({ source: "piprail" }),
  ]);
  for (const record of merged[0]?.evidence ?? []) {
    assert.equal(
      record.classification,
      "observed",
      "three agreeing catalogues must not manufacture verified evidence",
    );
  }
});

test("aggregate: merged actionability keeps live purchase false", () => {
  const merged = dedupeServices([
    service({ source: "cdp_bazaar", priceDecimal: "0.02" }),
    service({ source: "agent402" }),
  ]);
  assert.equal(merged[0]?.actionability.canPurchase, false);
  assert.equal(merged[0]?.actionability.canQuote, true, "capability is the union");
});

test("aggregate: an empty input yields an empty result", () => {
  assert.deepEqual(dedupeServices([]), []);
  assert.deepEqual(dedupeWork([]), []);
});

test("aggregate: work identity is per-source and never merges across platforms", () => {
  const deduped = dedupeWork([
    work({ source: "agent_bounties", externalId: "42" }),
    work({ source: "bountybook", externalId: "42" }),
  ]);
  assert.equal(deduped.length, 2, "bounty 42 on two platforms is two pieces of work");
});

test("aggregate: duplicate work within one scan keeps the newest observation", () => {
  const older = work({ source: "agent_bounties", externalId: "42" });
  const newer = { ...older, observedAt: "2026-08-19T12:00:00.000Z", title: "newer" };
  const deduped = dedupeWork([older, newer]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.title, "newer");
});

test("aggregate: closed and unfunded work is excluded", () => {
  const candidates = [
    work({ source: "agent_bounties", externalId: "open-funded" }),
    work({ source: "agent_bounties", externalId: "closed", status: "closed" }),
    work({ source: "agent_bounties", externalId: "unfunded", fundingState: "unfunded" }),
    work({ source: "agent_bounties", externalId: "advertised", fundingState: "advertised" }),
    work({ source: "agent_bounties", externalId: "settled", fundingState: "settled" }),
    work({ source: "agent_bounties", externalId: "refunded", fundingState: "refunded" }),
    work({ source: "agent_bounties", externalId: "unknown-status", status: "unknown" }),
  ];
  const earnable = filterEarnableWork(candidates);
  assert.deepEqual(
    earnable.map((w) => w.externalId),
    ["open-funded"],
  );
});

test("aggregate: unearnable work can be included explicitly for auditing", () => {
  const candidates = [
    work({ source: "agent_bounties", externalId: "a" }),
    work({ source: "agent_bounties", externalId: "b", status: "closed" }),
  ];
  assert.equal(filterEarnableWork(candidates, { includeUnearnable: true }).length, 2);
});

test("aggregate: aggregateWork dedupes then filters deterministically", () => {
  const candidates = [
    work({ source: "bountybook", externalId: "z" }),
    work({ source: "agent_bounties", externalId: "a" }),
    work({ source: "agent_bounties", externalId: "closed", status: "closed" }),
  ];
  const first = aggregateWork(candidates);
  const second = aggregateWork([...candidates].reverse());
  assert.equal(first.length, 2);
  assert.equal(hashCanonical(first), hashCanonical(second), "order independent");
});
