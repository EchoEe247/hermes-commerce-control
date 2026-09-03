import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  Agent402Adapter,
  canonicalNetwork,
  parseDisplayPrice,
  splitRoute,
} from "../src/adapters/agent402/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { canonicalServiceId } from "../src/core/ids.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  EMPTY_FIND_RESPONSE,
  FIND_RESPONSE,
  MALFORMED_FIND_RESPONSE,
  OVERLAP_PRICING_RESPONSE,
  PRICING_RESPONSE,
} from "./fixtures/agent402/responses.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

function stubFetch(responder: (url: string) => unknown): { fetch: SafeFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: SafeFetch = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      const r = responder(url);
      if (r instanceof Error) throw r;
      return r as T;
    },
    text: async (url: string) => {
      urls.push(url);
      return { status: 200, url, headers: {}, bytes: 0, text: JSON.stringify(responder(url)) };
    },
  };
  return { fetch, urls };
}

function ctx(fetch: SafeFetch): AdapterContext {
  return {
    fetch,
    evidence: new EvidenceCollector("agent402", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

test("agent402: parseDisplayPrice reads the display string, not the float", () => {
  assert.equal(parseDisplayPrice("$0.003")?.decimal, "0.003");
  assert.equal(parseDisplayPrice("$0.010")?.decimal, "0.01");
  assert.equal(parseDisplayPrice("$1")?.decimal, "1");
  assert.equal(parseDisplayPrice("$0.010")?.usd, "0.01");
  assert.equal(parseDisplayPrice("$0.010")?.currency, "USDC");
  // Unreadable prices yield undefined rather than a guess.
  for (const bad of ["three cents", "", "0.003", "$", "$abc", "$1e-3", "free", null, 0.003]) {
    assert.equal(parseDisplayPrice(bad), undefined, `should reject ${String(bad)}`);
  }
});

test("agent402: splitRoute separates the combined route field", () => {
  assert.deepEqual(splitRoute("GET /api/gov-data"), { method: "GET", path: "/api/gov-data" });
  assert.deepEqual(splitRoute("post /api/extract"), { method: "POST", path: "/api/extract" });
  for (const bad of ["/api/x", "GET", "", "GET api/x", null, 42]) {
    assert.equal(splitRoute(bad), null, `should reject ${String(bad)}`);
  }
});

test("agent402: friendly network names map to CAIP-2 without faking unknowns", () => {
  assert.equal(canonicalNetwork("base"), "eip155:8453");
  assert.equal(canonicalNetwork("base-sepolia"), "eip155:84532");
  assert.equal(canonicalNetwork("polygon"), "eip155:137");
  // Unknown labels are preserved verbatim, not invented.
  assert.equal(canonicalNetwork("stellar"), "stellar");
  assert.equal(canonicalNetwork(undefined), undefined);
});

test("agent402: /api/find results normalize with price and route", async () => {
  const stub = stubFetch(() => FIND_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const services = await adapter.discoverServices({ q: "data" }, ctx(stub.fetch));

  assert.match(stub.urls[0] ?? "", /\/api\/find\?q=data/);
  assert.equal(services.length, 3);

  const gov = services.find((s) => s.resourceUrl.endsWith("/api/gov-data"));
  assert.ok(gov);
  assert.equal(gov?.method, "GET");
  assert.equal(gov?.protocol, "x402");
  assert.equal(gov?.network, "eip155:8453");
  assert.equal(gov?.price?.decimal, "0.003");
  assert.equal(gov?.price?.usd, "0.003");
  assert.equal(gov?.asset?.decimals, 6);
  assert.equal(gov?.actionability.canPurchase, false);
  assert.equal(gov?.actionability.canPreparePurchase, true);

  const extract = services.find((s) => s.resourceUrl.endsWith("/api/extract"));
  assert.equal(extract?.method, "POST");
  assert.equal(extract?.price?.decimal, "0.01");
});

test("agent402: a result with no price is unknown, not free", async () => {
  const stub = stubFetch(() => FIND_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const services = await adapter.discoverServices({ q: "data" }, ctx(stub.fetch));
  const mystery = services.find((s) => s.resourceUrl.endsWith("/api/mystery"));
  assert.ok(mystery);
  assert.equal(mystery?.price, undefined);
  assert.equal(mystery?.actionability.canQuote, false);
  assert.equal(mystery?.actionability.canPreparePurchase, false);
});

test("agent402: catalog discovery uses /api/pricing and honours its baseUrl", async () => {
  const stub = stubFetch(() => PRICING_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const services = await adapter.discoverServices({}, ctx(stub.fetch));
  assert.match(stub.urls[0] ?? "", /\/api\/pricing$/);
  assert.equal(services.length, 3);
  for (const s of services) {
    assert.ok(s.resourceUrl.startsWith("https://agent402.tools/"), s.resourceUrl);
  }
});

test("agent402: a non-machine-readable catalog price is rejected as tentative", async () => {
  const stub = stubFetch(() => PRICING_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const services = await adapter.discoverServices({}, ctx(stub.fetch));
  const weird = services.find((s) => s.resourceUrl.endsWith("/api/weird"));
  assert.ok(weird);
  assert.equal(weird?.price, undefined, '"three cents" must not become a price');
  assert.ok(
    (weird?.evidence ?? []).some((e) => e.classification === "tentative"),
    "rejection should be recorded as tentative evidence",
  );
});

test("agent402: the overlap fixture yields the same canonical ID as CDP Bazaar", async () => {
  const stub = stubFetch(() => OVERLAP_PRICING_RESPONSE);
  const adapter = new Agent402Adapter("https://api.onesource.example");
  const services = await adapter.discoverServices({}, ctx(stub.fetch));
  assert.equal(services.length, 1);
  const expected = canonicalServiceId({
    resourceUrl: "https://api.onesource.example/api/chain/erc20-balance",
    method: "GET",
    protocol: "x402",
    network: "eip155:8453",
    payTo: undefined,
  });
  assert.equal(services[0]?.id, expected);
});

test("agent402: an empty find is success with zero results", async () => {
  const stub = stubFetch(() => EMPTY_FIND_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  assert.deepEqual(await adapter.discoverServices({ q: "nothing" }, ctx(stub.fetch)), []);
});

test("agent402: a malformed response raises UPSTREAM_MALFORMED", async () => {
  const stub = stubFetch(() => MALFORMED_FIND_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  await assert.rejects(
    () => adapter.discoverServices({ q: "x" }, ctx(stub.fetch)),
    /UPSTREAM_MALFORMED/,
  );
  const stub2 = stubFetch(() => ({ endpoints: "nope" }));
  await assert.rejects(() => adapter.discoverServices({}, ctx(stub2.fetch)), /UPSTREAM_MALFORMED/);
});

test("agent402: timeout, 429 and 5xx propagate as typed errors", async () => {
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  for (const [code, pattern] of [
    ["UPSTREAM_TIMEOUT", /UPSTREAM_TIMEOUT/],
    ["UPSTREAM_RATE_LIMITED", /UPSTREAM_RATE_LIMITED/],
    ["UPSTREAM_UNAVAILABLE", /UPSTREAM_UNAVAILABLE/],
  ] as const) {
    const stub = stubFetch(() => new CommerceError(code, "boom"));
    await assert.rejects(() => adapter.discoverServices({}, ctx(stub.fetch)), pattern);
  }
});

test("agent402: quote is never executable", async () => {
  const stub = stubFetch(() => PRICING_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const quote = await adapter.quote("extract", ctx(stub.fetch));
  assert.equal(quote.executable, false);
  assert.equal(quote.price?.decimal, "0.01");
});

test("agent402: preparePurchase performs no call and records the block", async () => {
  const stub = stubFetch(() => PRICING_RESPONSE);
  const adapter = new Agent402Adapter(cfg.adapters.agent402.baseUrl);
  const prepared = await adapter.preparePurchase("gov-data", ctx(stub.fetch));
  assert.match(String(prepared.settlementNote), /Mode A/);
  // Only the catalogue endpoint was fetched; no paid route was invoked.
  for (const url of stub.urls) {
    assert.match(url, /\/api\/pricing$/, `unexpected request to ${url}`);
  }
});

test("agent402: the adapter never invokes the LLM gateway or proof-of-work path", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/adapters/agent402/index.ts", import.meta.url), "utf8");
  for (const forbidden of ["/api/pow/challenge", "/api/llm", "priceUsd)"]) {
    assert.equal(source.includes(forbidden), false, `source must not reference ${forbidden}`);
  }
  assert.equal(source.includes("this.abs(\"/api/pricing\")"), true);
});

test("agent402: capabilities never advertise live execution", () => {
  const caps = new Agent402Adapter(cfg.adapters.agent402.baseUrl).capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.walletless, true);
});
