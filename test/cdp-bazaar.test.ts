import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { CdpBazaarAdapter, normalizeBazaarItem } from "../src/adapters/cdp-bazaar/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { canonicalServiceId } from "../src/core/ids.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import { CommerceError } from "../src/core/errors.js";
import {
  BROWSE_RESPONSE,
  DUPLICATE_RESOURCE,
  EMPTY_SEARCH_RESPONSE,
  MALFORMED_AMOUNT_RESOURCE,
  MALFORMED_ENVELOPE,
  MISSING_PRICE_RESOURCE,
  MISSING_QUALITY_RESOURCE,
  SEARCH_RESPONSE,
  SEPOLIA_RESOURCE,
  VALID_RESOURCE,
} from "./fixtures/cdp-bazaar/responses.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

/** A fetch stub that records the URLs requested and replays fixtures. */
function stubFetch(
  responder: (url: string) => unknown,
): { fetch: SafeFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: SafeFetch = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      const result = responder(url);
      if (result instanceof Error) throw result;
      return result as T;
    },
    text: async (url: string) => {
      urls.push(url);
      return {
        status: 200,
        url,
        headers: {},
        bytes: 0,
        text: JSON.stringify(responder(url)),
      };
    },
  };
  return { fetch, urls };
}

function ctx(fetch: SafeFetch): AdapterContext {
  return {
    fetch,
    evidence: new EvidenceCollector("cdp_bazaar", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

function bareCtx(): AdapterContext {
  return ctx(stubFetch(() => ({})).fetch);
}

test("cdp-bazaar: normalizes a valid resource into a canonical service", () => {
  const context = bareCtx();
  const service = normalizeBazaarItem(VALID_RESOURCE, context, "https://api.example/probe");
  assert.ok(service !== null);
  assert.equal(service?.kind, "service");
  assert.equal(service?.resourceUrl, "https://api.onesource.example/api/chain/erc20-balance");
  assert.equal(service?.protocol, "x402");
  assert.equal(service?.network, "eip155:8453");
  assert.equal(service?.method, "GET", "method should come from the bazaar input extension");
  assert.equal(service?.description, "ERC20 token balance for any wallet via balanceOf");
  assert.equal(service?.payTo, "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea");
  // Atomic amount preserved exactly; 3000 at 6 decimals is 0.003 USDC.
  assert.equal(service?.price?.atomic, "3000");
  assert.equal(service?.price?.decimal, "0.003");
  assert.equal(service?.price?.currency, "USDC");
  assert.equal(service?.price?.usd, "0.003");
  assert.equal(service?.asset?.decimals, 6);
  // 30-day activity metrics.
  assert.equal(service?.activity?.calls30d, 914);
  assert.equal(service?.activity?.uniquePayers30d, 910);
  // Mode A.
  assert.equal(service?.actionability.canPurchase, false);
  assert.equal(service?.actionability.canQuote, true);
  assert.equal(service?.actionability.canPreparePurchase, true);
  // Evidence is observed, never verified.
  assert.ok((service?.evidence.length ?? 0) > 0);
  for (const record of service?.evidence ?? []) {
    assert.notEqual(record.classification, "verified");
  }
});

test("cdp-bazaar: a Base Sepolia $0.02 resource maps exactly", () => {
  const service = normalizeBazaarItem(SEPOLIA_RESOURCE, bareCtx(), "https://api.example/probe");
  assert.equal(service?.network, "eip155:84532");
  assert.equal(service?.price?.atomic, "20000");
  assert.equal(service?.price?.decimal, "0.02");
  assert.equal(service?.price?.display, "$0.02");
  assert.equal(service?.method, "POST");
});

test("cdp-bazaar: a missing price yields no price rather than a guessed zero", () => {
  const service = normalizeBazaarItem(MISSING_PRICE_RESOURCE, bareCtx(), "https://x/y");
  assert.ok(service !== null);
  assert.equal(service?.price, undefined);
  assert.equal(service?.actionability.canQuote, false, "cannot quote without a price");
  assert.equal(service?.actionability.canPreparePurchase, false);
});

test("cdp-bazaar: a malformed amount is rejected, not coerced", () => {
  const context = bareCtx();
  const service = normalizeBazaarItem(MALFORMED_AMOUNT_RESOURCE, context, "https://x/y");
  assert.ok(service !== null);
  // "1.5e3" must not become 1500.
  assert.equal(service?.price, undefined);
  const tentative = service?.evidence.filter((e) => e.classification === "tentative") ?? [];
  assert.ok(tentative.length > 0, "rejection should be recorded as tentative evidence");
});

test("cdp-bazaar: missing quality means unknown activity, not zero", () => {
  const service = normalizeBazaarItem(MISSING_QUALITY_RESOURCE, bareCtx(), "https://x/y");
  assert.equal(service?.activity, undefined, "absent quality must be undefined not 0");
});

test("cdp-bazaar: multiple accepts select the cheapest exact scheme", () => {
  const service = normalizeBazaarItem(BROWSE_RESPONSE.items[1]!, bareCtx(), "https://x/y");
  // exact and batch-settlement are both 3000; agent-pay on Solana is 5000.
  // exact must win, so the network stays Base mainnet.
  assert.equal(service?.network, "eip155:8453");
  assert.equal(service?.price?.atomic, "3000");
});

test("cdp-bazaar: a cosmetically different duplicate collapses to one ID", () => {
  const a = normalizeBazaarItem(VALID_RESOURCE, bareCtx(), "https://x/y");
  const b = normalizeBazaarItem(DUPLICATE_RESOURCE, bareCtx(), "https://x/y");
  assert.ok(a !== null && b !== null);
  assert.equal(a?.id, b?.id, "host case and :443 must not change identity");
  assert.equal(
    a?.id,
    canonicalServiceId({
      resourceUrl: "https://api.onesource.example/api/chain/erc20-balance",
      method: "GET",
      protocol: "x402",
      network: "eip155:8453",
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
    }),
  );
});

test("cdp-bazaar: an item without a usable resource URL is skipped", () => {
  for (const bad of [
    {},
    { resource: "" },
    { resource: "not a url" },
    { resource: "ftp://example.com/x" },
    { resource: 42 },
  ]) {
    assert.equal(normalizeBazaarItem(bad, bareCtx(), "https://x/y"), null);
  }
});

test("cdp-bazaar: browse uses /resources and search uses /search with limit 20", async () => {
  const browse = stubFetch(() => BROWSE_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const browsed = await adapter.discoverServices({}, ctx(browse.fetch));
  assert.ok(browsed.length >= 5);
  assert.match(browse.urls[0] ?? "", /\/resources\?/);

  const search = stubFetch(() => SEARCH_RESPONSE);
  const found = await adapter.discoverServices({ q: "data quality" }, ctx(search.fetch));
  assert.equal(found.length, 2);
  const url = search.urls[0] ?? "";
  assert.match(url, /\/search\?/);
  assert.match(url, /query=data\+quality|query=data%20quality/);
  assert.match(url, /limit=20/);
});

test("cdp-bazaar: a caller cannot exceed the upstream search limit cap", async () => {
  const search = stubFetch(() => SEARCH_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  await adapter.discoverServices({ q: "x", limit: 500 }, ctx(search.fetch));
  assert.match(search.urls[0] ?? "", /limit=20/, "limit must be clamped to the upstream max");
});

test("cdp-bazaar: an empty search is success with zero results", async () => {
  const search = stubFetch(() => EMPTY_SEARCH_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const found = await adapter.discoverServices({ q: "nothing matches" }, ctx(search.fetch));
  assert.deepEqual(found, []);
});

test("cdp-bazaar: a malformed envelope raises UPSTREAM_MALFORMED", async () => {
  const bad = stubFetch(() => MALFORMED_ENVELOPE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  await assert.rejects(
    () => adapter.discoverServices({}, ctx(bad.fetch)),
    /UPSTREAM_MALFORMED/,
  );
});

test("cdp-bazaar: a 429 propagates as UPSTREAM_RATE_LIMITED", async () => {
  const limited = stubFetch(() => new CommerceError("UPSTREAM_RATE_LIMITED", "rate limited"));
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  await assert.rejects(
    () => adapter.discoverServices({}, ctx(limited.fetch)),
    /UPSTREAM_RATE_LIMITED/,
  );
});

test("cdp-bazaar: a 5xx propagates as UPSTREAM_UNAVAILABLE", async () => {
  const down = stubFetch(() => new CommerceError("UPSTREAM_UNAVAILABLE", "HTTP 503"));
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  await assert.rejects(
    () => adapter.discoverServices({}, ctx(down.fetch)),
    /UPSTREAM_UNAVAILABLE/,
  );
});

test("cdp-bazaar: quote preserves the atomic amount and is never executable", async () => {
  const search = stubFetch(() => SEARCH_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const quote = await adapter.quote("https://profiler.example/v1/profile", ctx(search.fetch));
  assert.equal(quote.price?.atomic, "20000");
  assert.equal(quote.price?.decimal, "0.02");
  assert.equal(quote.executable, false);
});

test("cdp-bazaar: inspect on an unknown resource is NOT_FOUND", async () => {
  const search = stubFetch(() => EMPTY_SEARCH_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  await assert.rejects(
    () => adapter.inspect("https://absent.example/v1/x", ctx(search.fetch)),
    /NOT_FOUND/,
  );
});

test("cdp-bazaar: preparePurchase returns facts and states the block", async () => {
  const search = stubFetch(() => SEARCH_RESPONSE);
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const prepared = await adapter.preparePurchase(
    "https://profiler.example/v1/profile",
    ctx(search.fetch),
  );
  assert.equal(prepared.network, "eip155:84532");
  assert.match(String(prepared.settlementNote), /disabled in Mode A/);
});

test("cdp-bazaar: preparePublish never registers", async () => {
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const prepared = await adapter.preparePublish(
    {
      product: "data-quality-profiler",
      version: "0.1.0",
      resourceUrl: "https://profiler.example/v1/profile",
      method: "POST",
      protocol: "x402",
      network: "eip155:84532",
      price: "$0.02",
      description: "Profiles a dataset",
      metadata: {},
    },
    bareCtx(),
  );
  assert.equal(prepared.registrationPerformed, false);
  assert.equal(prepared.metadataPrepared, true);
  assert.match(String(prepared.indexingNote), /settlement/i);
});

test("cdp-bazaar: capabilities never advertise live execution", () => {
  const adapter = new CdpBazaarAdapter(cfg.adapters.cdp_bazaar.baseUrl);
  const caps = adapter.capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.walletless, true);
  assert.equal(caps.discoverServices, true);
});

test("cdp-bazaar: the adapter source never contains a settle or proxy call", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/adapters/cdp-bazaar/index.ts", import.meta.url),
    "utf8",
  );
  // Forbidden CDP surfaces must not be invoked. They may only appear in prose.
  for (const forbidden of ["proxy_tool_call(", "/settle", "/verify"]) {
    assert.equal(source.includes(forbidden), false, `source must not call ${forbidden}`);
  }
});
