import test from "node:test";
import assert from "node:assert/strict";
import { sanitize, sanitizeText, SECRET_KEY_PATTERN } from "../src/evidence/sanitize.js";
import { hashBytes, hashCanonical } from "../src/evidence/hashing.js";
import { makeEvidence, upgradeGuard } from "../src/evidence/provenance.js";
import { EvidenceCollector } from "../src/evidence/capture.js";

test("evidence: sanitizer redacts credential-bearing keys recursively", () => {
  const input = {
    ok: "keep me",
    Authorization: "Bearer secret-token-value",
    headers: {
      authorization: "Bearer another-one",
      "x-api-key": "ak_live_should_vanish",
      Cookie: "session=abc123",
      "set-cookie": ["a=b"],
    },
    wallet: {
      privateKey: "0xdeadbeefdeadbeef",
      private_key: "0xcafe",
      mnemonic: "test test test test test test test test test test test junk",
      seedPhrase: "abandon abandon abandon",
      nwc: "nostr+walletconnect://npub?secret=xyz",
    },
    tokens: {
      access_token: "at_123",
      refreshToken: "rt_456",
      idToken: "it_789",
    },
    payment: { "PAYMENT-SIGNATURE": "0xsig", xPayment: "base64blob" },
    nested: [{ apiSecret: "shh" }, { fine: "visible" }],
  };

  const out = sanitize(input) as Record<string, unknown>;
  const serialized = JSON.stringify(out);

  for (const leak of [
    "secret-token-value",
    "another-one",
    "ak_live_should_vanish",
    "abc123",
    "0xdeadbeefdeadbeef",
    "0xcafe",
    "junk",
    "abandon",
    "xyz",
    "at_123",
    "rt_456",
    "it_789",
    "0xsig",
    "base64blob",
    "shh",
  ]) {
    assert.equal(serialized.includes(leak), false, `sanitizer leaked ${leak}`);
  }

  assert.equal(out.ok, "keep me");
  assert.ok(serialized.includes("visible"), "non-secret data must survive");
  assert.ok(serialized.includes("[REDACTED]"), "redaction marker expected");
});

test("evidence: sanitizer preserves structure and array shape", () => {
  const out = sanitize({ list: [1, 2, 3], obj: { a: { b: "c" } } }) as Record<string, unknown>;
  assert.deepEqual(out.list, [1, 2, 3]);
  assert.deepEqual(out.obj, { a: { b: "c" } });
});

test("evidence: sanitizer redacts secret-looking values even under benign keys", () => {
  const out = sanitize({
    note: "my key is 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    bearer: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
  });
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes("0123456789abcdef0123456789abcdef"), false);
  assert.equal(serialized.includes("eyJhbGciOiJIUzI1NiJ9"), false);
});

test("evidence: sanitizeText redacts inline credentials in free text", () => {
  const text = sanitizeText(
    "curl -H 'Authorization: Bearer abc.def.ghi' https://x/ && export PRIVATE_KEY=0xabc123",
  );
  assert.equal(text.includes("abc.def.ghi"), false);
  assert.equal(text.includes("0xabc123"), false);
  assert.ok(text.includes("curl"), "non-secret text must survive");
});

test("evidence: SECRET_KEY_PATTERN matches the forbidden classes", () => {
  for (const key of [
    "authorization",
    "api_key",
    "apiKey",
    "x-api-key",
    "cookie",
    "set-cookie",
    "private_key",
    "privateKey",
    "mnemonic",
    "seed_phrase",
    "nwc",
    "access_token",
    "refresh_token",
    "secret",
    "password",
    "passphrase",
    "session",
    "credential",
    "payment-signature",
    "x-payment",
  ]) {
    assert.ok(SECRET_KEY_PATTERN.test(key), `pattern should match ${key}`);
  }
  for (const key of ["price", "network", "description", "name", "resourceUrl", "keywords"]) {
    assert.equal(SECRET_KEY_PATTERN.test(key), false, `pattern should not match ${key}`);
  }
});

test("evidence: hashing is stable and key-order independent", () => {
  assert.equal(hashCanonical({ a: 1, b: 2 }), hashCanonical({ b: 2, a: 1 }));
  assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));
  assert.match(hashBytes(new TextEncoder().encode("abc")), /^[0-9a-f]{64}$/);
});

test("evidence: makeEvidence hashes the sanitized value, never the raw one", () => {
  const rec = makeEvidence({
    platform: "cdp_bazaar",
    fact: "price",
    value: "0.02",
    classification: "observed",
    sourceType: "http_api",
    sourceRef: "https://api.example.com/x",
    capturedAt: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(rec.classification, "observed");
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
});

test("evidence: adapters cannot silently upgrade an evidence classification", () => {
  // observed -> verified requires authoritative proof; without it, upgrade is refused.
  assert.throws(() => upgradeGuard("observed", "verified", false), /EVIDENCE|upgrade/i);
  assert.equal(upgradeGuard("observed", "verified", true), "verified");
  // Downgrades and same-class transitions are always fine.
  assert.equal(upgradeGuard("verified", "observed", false), "observed");
  assert.equal(upgradeGuard("observed", "observed", false), "observed");
  assert.throws(() => upgradeGuard("tentative", "verified", false), /EVIDENCE|upgrade/i);
  assert.throws(() => upgradeGuard("inferred", "observed", false), /EVIDENCE|upgrade/i);
});

test("evidence: collector sanitizes captures and records provenance", () => {
  const collector = new EvidenceCollector("cdp_bazaar", () => "2026-08-19T00:00:00.000Z");
  collector.observe("price", "0.02", "http_api", "https://api.example.com/x");
  const capture = collector.capture("raw_response", {
    price: "0.02",
    Authorization: "Bearer nope",
  });
  assert.equal(JSON.stringify(capture.sanitized).includes("nope"), false);
  assert.match(capture.hash, /^[0-9a-f]{64}$/);
  const records = collector.records();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.platform, "cdp_bazaar");
  assert.equal(records[0]?.classification, "observed");
});

test("evidence: collector refuses to record a verified class without proof", () => {
  const collector = new EvidenceCollector("agent_bounties", () => "2026-08-19T00:00:00.000Z");
  assert.throws(
    () => collector.verified("payment", "settled", "http_api", "https://x/y", false),
    /EVIDENCE|proof/i,
  );
  const ok = collector.verified("payment", "settled", "onchain", "0xtxhash", true);
  assert.equal(ok.classification, "verified");
});
