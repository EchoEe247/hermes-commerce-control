import test from "node:test";
import assert from "node:assert/strict";
import { buildAppMetadata } from "../src/app.js";
import {
  normalizeDecimalString,
  compareDecimalStrings,
  parseAuthoritativeAmount,
  atomicToDecimalString,
  decimalToAtomicString,
} from "../src/core/money.js";
import {
  canonicalServiceId,
  canonicalWorkId,
  normalizeResourceUrl,
  sha256Hex,
  canonicalJson,
} from "../src/core/ids.js";
import {
  parseServiceCandidate,
  parseWorkCandidate,
  parseEvidenceRecord,
} from "../src/core/schemas.js";
import { modeAServiceActionability, modeAWorkActionability } from "../src/core/models.js";
import { CommerceError, isCommerceError } from "../src/core/errors.js";

test("app metadata is Mode A", () => {
  assert.deepEqual(buildAppMetadata(), {
    name: "hermes-commerce-control",
    version: "0.1.0",
    mode: "A",
  });
});

test("money: normalizeDecimalString strips insignificant zeroes", () => {
  assert.equal(normalizeDecimalString("0001.2300"), "1.23");
  assert.equal(normalizeDecimalString("0.020"), "0.02");
  assert.equal(normalizeDecimalString("10"), "10");
  assert.equal(normalizeDecimalString("10.000"), "10");
  assert.equal(normalizeDecimalString(".5"), "0.5");
  assert.equal(normalizeDecimalString("0"), "0");
  assert.equal(normalizeDecimalString("000"), "0");
  assert.equal(normalizeDecimalString("+1.5"), "1.5");
});

test("money: compareDecimalStrings is decimal-exact", () => {
  assert.equal(compareDecimalStrings("0.02", "0.2"), -1);
  assert.equal(compareDecimalStrings("0.2", "0.02"), 1);
  assert.equal(compareDecimalStrings("1.230", "1.23"), 0);
  assert.equal(compareDecimalStrings("10", "9.999999"), 1);
  // Exceeds IEEE-754 double precision; string comparison must still be exact.
  assert.equal(
    compareDecimalStrings("0.10000000000000000001", "0.10000000000000000002"),
    -1,
  );
});

test("money: malformed authoritative amounts are rejected", () => {
  for (const bad of [
    "NaN",
    "nan",
    "Infinity",
    "-Infinity",
    "1e-3",
    "1E5",
    "0x10",
    "1_000",
    "1,000",
    "",
    " ",
    "1.2.3",
    "--1",
    "1.",
    "abc",
    "$0.02",
    "0.02 USDC",
  ]) {
    assert.throws(
      () => parseAuthoritativeAmount(bad),
      /INVALID_AMOUNT/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => parseAuthoritativeAmount(0.02 as unknown as string), /INVALID_AMOUNT/);
  assert.throws(() => parseAuthoritativeAmount(null as unknown as string), /INVALID_AMOUNT/);
});

test("money: negative prices and rewards are rejected", () => {
  assert.throws(() => parseAuthoritativeAmount("-1"), /INVALID_AMOUNT/);
  assert.throws(() => parseAuthoritativeAmount("-0.01"), /INVALID_AMOUNT/);
  // Negative zero is not a meaningful price.
  assert.throws(() => parseAuthoritativeAmount("-0"), /INVALID_AMOUNT/);
  assert.equal(parseAuthoritativeAmount("0"), "0");
});

test("money: atomic <-> decimal conversion is exact for 6-decimal USDC", () => {
  assert.equal(atomicToDecimalString("20000", 6), "0.02");
  assert.equal(atomicToDecimalString("1", 6), "0.000001");
  assert.equal(atomicToDecimalString("1000000", 6), "1");
  assert.equal(atomicToDecimalString("0", 6), "0");
  assert.equal(decimalToAtomicString("0.02", 6), "20000");
  assert.equal(decimalToAtomicString("1", 6), "1000000");
  // Excess precision for the asset must fail rather than silently round.
  assert.throws(() => decimalToAtomicString("0.0000001", 6), /INVALID_AMOUNT/);
  assert.throws(() => atomicToDecimalString("0.5", 6), /INVALID_AMOUNT/);
});

test("ids: resource URL normalization is canonical", () => {
  assert.equal(
    normalizeResourceUrl("HTTPS://API.Example.COM:443/v1/Profile"),
    "https://api.example.com/v1/Profile",
  );
  assert.equal(
    normalizeResourceUrl("http://api.example.com:80/v1/x/"),
    "http://api.example.com/v1/x",
  );
  assert.equal(
    normalizeResourceUrl("https://api.example.com/v1/x?b=2&a=1#frag"),
    "https://api.example.com/v1/x?a=1&b=2",
  );
  assert.throws(() => normalizeResourceUrl("ftp://example.com/x"), /INVALID_URL/);
  assert.throws(() => normalizeResourceUrl("not a url"), /INVALID_URL/);
});

test("ids: canonical service ID collapses case differences", () => {
  const a = canonicalServiceId({
    resourceUrl: "HTTPS://API.Example.com/v1/profile",
    method: "post",
    protocol: "x402",
    network: "eip155:84532",
    payTo: "0xABCdef0000000000000000000000000000000001",
  });
  const b = canonicalServiceId({
    resourceUrl: "https://api.example.com:443/v1/profile",
    method: "POST",
    protocol: "X402",
    network: "eip155:84532",
    payTo: "0xabcdef0000000000000000000000000000000001",
  });
  assert.equal(a, b);
  assert.match(a, /^svc_[0-9a-f]{32}$/);
});

test("ids: method, network and protocol changes produce different IDs", () => {
  const base = {
    resourceUrl: "https://api.example.com/v1/profile",
    method: "POST",
    protocol: "x402",
    network: "eip155:84532",
    payTo: "0xabcdef0000000000000000000000000000000001",
  } as const;
  const id = canonicalServiceId(base);
  assert.notEqual(id, canonicalServiceId({ ...base, method: "GET" }));
  assert.notEqual(id, canonicalServiceId({ ...base, network: "eip155:8453" }));
  assert.notEqual(id, canonicalServiceId({ ...base, protocol: "mpp" }));
  assert.notEqual(
    id,
    canonicalServiceId({ ...base, payTo: "0x0000000000000000000000000000000000000002" }),
  );
  // Unknown payTo must be stable and distinct from a known one.
  const unknownA = canonicalServiceId({
    resourceUrl: base.resourceUrl,
    method: base.method,
    protocol: base.protocol,
    network: base.network,
  });
  const unknownB = canonicalServiceId({
    resourceUrl: base.resourceUrl,
    method: base.method,
    protocol: base.protocol,
    network: base.network,
  });
  assert.equal(unknownA, unknownB);
  assert.notEqual(unknownA, id);
});

test("ids: canonical work ID is per-source stable", () => {
  const a = canonicalWorkId({ source: "agent_bounties", externalId: "42" });
  const b = canonicalWorkId({ source: "agent_bounties", externalId: "42" });
  const c = canonicalWorkId({ source: "bountybook", externalId: "42" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^wrk_[0-9a-f]{32}$/);
});

test("ids: canonicalJson orders keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(sha256Hex("abc").length, 64);
});

test("models: Mode-A actionability hardcodes live flags false", () => {
  const svc = modeAServiceActionability({ canQuote: true, canPreparePurchase: true });
  assert.equal(svc.canPurchase, false);
  assert.equal(svc.canQuote, true);
  assert.equal(svc.canPreparePurchase, true);
  assert.equal(Object.isFrozen(svc), true);

  const work = modeAWorkActionability({ canPrepareClaim: true });
  assert.equal(work.canClaim, false);
  assert.equal(work.canSubmit, false);
  assert.equal(work.canPrepareClaim, true);
  assert.equal(Object.isFrozen(work), true);
});

test("schemas: parseServiceCandidate accepts a valid candidate", () => {
  const parsed = parseServiceCandidate({
    id: "svc_00000000000000000000000000000001",
    kind: "service",
    sources: [
      { source: "cdp_bazaar", externalId: "res-1", observedAt: "2026-08-19T00:00:00.000Z" },
    ],
    name: "Data Quality Profiler",
    description: "Profiles a dataset",
    resourceUrl: "https://api.example.com/v1/profile",
    method: "POST",
    protocol: "x402",
    network: "eip155:84532",
    asset: {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      symbol: "USDC",
      decimals: 6,
    },
    price: { atomic: "20000", decimal: "0.02", display: "$0.02", currency: "USDC" },
    health: "ok",
    observedAt: "2026-08-19T00:00:00.000Z",
    tags: ["data"],
    evidence: [],
    actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
  });
  assert.equal(parsed.id, "svc_00000000000000000000000000000001");
  assert.equal(parsed.price?.decimal, "0.02");
});

test("schemas: parseServiceCandidate rejects live purchase actionability", () => {
  const build = (canPurchase: boolean) => ({
    id: "svc_00000000000000000000000000000001",
    kind: "service" as const,
    sources: [
      { source: "cdp_bazaar", externalId: "res-1", observedAt: "2026-08-19T00:00:00.000Z" },
    ],
    name: "x",
    resourceUrl: "https://api.example.com/v1/profile",
    method: "POST",
    protocol: "x402",
    health: "ok",
    observedAt: "2026-08-19T00:00:00.000Z",
    tags: [],
    evidence: [],
    actionability: { canQuote: true, canPreparePurchase: true, canPurchase },
  });
  assert.doesNotThrow(() => parseServiceCandidate(build(false)));
  assert.throws(() => parseServiceCandidate(build(true)));
});

test("schemas: parseWorkCandidate rejects live claim/submit actionability", () => {
  const base = {
    id: "wrk_00000000000000000000000000000001",
    kind: "work" as const,
    source: "agent_bounties",
    externalId: "42",
    title: "Fix a bug",
    reward: { amount: "5", asset: "USDC", network: "eip155:8453" },
    funding: { state: "funded", evidence: "observed" },
    verification: { type: "deterministic" },
    status: "open",
    requirements: [],
    observedAt: "2026-08-19T00:00:00.000Z",
    evidence: [],
  };
  assert.doesNotThrow(() =>
    parseWorkCandidate({
      ...base,
      actionability: { canPrepareClaim: true, canClaim: false, canSubmit: false },
    }),
  );
  assert.throws(() =>
    parseWorkCandidate({
      ...base,
      actionability: { canPrepareClaim: true, canClaim: true, canSubmit: false },
    }),
  );
  assert.throws(() =>
    parseWorkCandidate({
      ...base,
      actionability: { canPrepareClaim: true, canClaim: false, canSubmit: true },
    }),
  );
});

test("schemas: parseEvidenceRecord rejects an unknown evidence class", () => {
  assert.throws(() =>
    parseEvidenceRecord({
      platform: "cdp_bazaar",
      fact: "price",
      value: "0.02",
      classification: "trusted",
      sourceType: "http_api",
      sourceRef: "https://api.example.com/x",
      capturedAt: "2026-08-19T00:00:00.000Z",
      hash: "0".repeat(64),
    }),
  );
});

test("schemas: parseEvidenceRecord accepts the four canonical classes", () => {
  for (const classification of ["verified", "observed", "inferred", "tentative"]) {
    const rec = parseEvidenceRecord({
      platform: "cdp_bazaar",
      fact: "price",
      value: "0.02",
      classification,
      sourceType: "http_api",
      sourceRef: "https://api.example.com/x",
      capturedAt: "2026-08-19T00:00:00.000Z",
      hash: "0".repeat(64),
    });
    assert.equal(rec.classification, classification);
  }
});

test("errors: CommerceError carries a stable typed code", () => {
  const err = new CommerceError("UPSTREAM_TIMEOUT", "took too long", { platform: "the402" });
  assert.equal(err.code, "UPSTREAM_TIMEOUT");
  assert.equal(isCommerceError(err), true);
  assert.equal(isCommerceError(new Error("x")), false);
  assert.match(String(err), /UPSTREAM_TIMEOUT/);
  assert.equal(err.details.platform, "the402");
});
