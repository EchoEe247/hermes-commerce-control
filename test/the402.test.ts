import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  The402Adapter,
  normalizeThe402Service,
  parseThe402Price,
  providerSuccessRate,
} from "../src/adapters/the402/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  AUTOMATED_SERVICE,
  CATALOG_RESPONSE,
  DATA_API_SERVICE,
  EMPTY_CATALOG,
  HUMAN_SERVICE,
  MALFORMED_CATALOG,
  NEW_PROVIDER_SERVICE,
  UNKNOWN_PRICE_SERVICE,
} from "./fixtures/the402/responses.js";

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
    evidence: new EvidenceCollector("the402", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

function bareCtx(): AdapterContext {
  return ctx(stubFetch(() => ({})).fetch);
}

test("the402: normalizes the three service types", async () => {
  const stub = stubFetch(() => CATALOG_RESPONSE);
  const services = await new The402Adapter().discoverServices({}, ctx(stub.fetch));
  assert.equal(services.length, 5);

  const dataApi = services.find((s) => s.tags.includes("type:data_api"));
  const automated = services.find((s) => s.tags.includes("type:automated_service"));
  const human = services.find((s) => s.tags.includes("type:human_service"));
  assert.ok(dataApi, "data_api must normalize");
  assert.ok(automated, "automated_service must normalize");
  assert.ok(human, "human_service must normalize");
});

test("the402: protocol is the402, never fabricated as x402", async () => {
  const stub = stubFetch(() => CATALOG_RESPONSE);
  const services = await new The402Adapter().discoverServices({}, ctx(stub.fetch));
  for (const s of services) {
    assert.equal(s.protocol, "the402");
    assert.equal(s.network, undefined, "no chain network should be invented");
    assert.equal(s.payTo, undefined, "no payTo should be invented");
  }
});

test("the402: prefers the agent-facing price", () => {
  const service = normalizeThe402Service(DATA_API_SERVICE, bareCtx(), "https://x/y");
  // agent_price 2.75 is what this control plane would pay, not price 2.50.
  assert.equal(service?.price?.decimal, "2.75");
  assert.equal(service?.price?.usd, "2.75");
  assert.equal(service?.price?.currency, "USD");
});

test("the402: a variable pricing model yields an unknown price, not zero", () => {
  const service = normalizeThe402Service(UNKNOWN_PRICE_SERVICE, bareCtx(), "https://x/y");
  assert.ok(service !== null);
  assert.equal(service?.price, undefined);
  assert.equal(service?.actionability.canQuote, false);
  assert.ok(
    (service?.evidence ?? []).some((e) => e.classification === "tentative"),
    "unknown price should be recorded as tentative",
  );
});

test("the402: parseThe402Price rejects junk and exponent forms", () => {
  assert.equal(parseThe402Price("2.50")?.decimal, "2.5");
  assert.equal(parseThe402Price(0.75)?.decimal, "0.75");
  assert.equal(parseThe402Price(40)?.decimal, "40");
  for (const bad of [null, undefined, "", "free", "1e3", "-5", "$2.50", Number.NaN]) {
    assert.equal(parseThe402Price(bad), undefined, `should reject ${String(bad)}`);
  }
});

test("the402: a new provider gets unknown confidence, not an inflated score", () => {
  assert.equal(providerSuccessRate(NEW_PROVIDER_SERVICE), undefined);
  assert.equal(providerSuccessRate(DATA_API_SERVICE), 0.94);
  // Out-of-range values are clamped rather than trusted blindly.
  assert.equal(providerSuccessRate({ provider_completion_rate: 5 }), 1);
  assert.equal(providerSuccessRate({ provider_completion_rate: -2 }), 0);

  const service = normalizeThe402Service(NEW_PROVIDER_SERVICE, bareCtx(), "https://x/y");
  assert.equal(service?.activity?.successRate, undefined);
});

test("the402: an unhealthy webhook downgrades health to degraded", () => {
  const healthy = normalizeThe402Service(AUTOMATED_SERVICE, bareCtx(), "https://x/y");
  const unhealthy = normalizeThe402Service(HUMAN_SERVICE, bareCtx(), "https://x/y");
  assert.equal(healthy?.health, "ok");
  assert.equal(unhealthy?.health, "degraded", "webhook_healthy false is a real availability signal");
});

test("the402: verification tier and reputation are recorded as observed", () => {
  const context = bareCtx();
  const service = normalizeThe402Service(DATA_API_SERVICE, context, "https://x/y");
  const tier = service?.evidence.find((e) => e.fact === "provider_verification_tier");
  assert.equal(tier?.classification, "observed");
  assert.equal(tier?.value, "unverified");
  for (const record of service?.evidence ?? []) {
    assert.notEqual(record.classification, "verified", "no the402 fact is cryptographically proven");
  }
});

test("the402: only allowlisted query parameters reach the upstream URL", async () => {
  const stub = stubFetch(() => CATALOG_RESPONSE);
  await new The402Adapter().discoverServices(
    { q: "research", maxUsdPrice: "5.00", limit: 10 },
    ctx(stub.fetch),
  );
  const url = new URL(stub.urls[0] ?? "https://x/y");
  const keys = [...url.searchParams.keys()].sort();
  assert.deepEqual(keys, ["limit", "max_price", "q"]);
  assert.equal(url.searchParams.get("max_price"), "5");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.pathname, "/v1/services/catalog");
});

test("the402: the limit is clamped and a junk max price is dropped", async () => {
  const stub = stubFetch(() => CATALOG_RESPONSE);
  await new The402Adapter().discoverServices(
    { limit: 9999, maxUsdPrice: "not-a-number" },
    ctx(stub.fetch),
  );
  const url = new URL(stub.urls[0] ?? "https://x/y");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.has("max_price"), false);
});

test("the402: an empty catalog is success with zero results", async () => {
  const stub = stubFetch(() => EMPTY_CATALOG);
  const adapter = new The402Adapter();
  assert.deepEqual(await adapter.discoverServices({}, ctx(stub.fetch)), []);
  assert.equal((await adapter.health(ctx(stub.fetch))).status, "ok");
});

test("the402: upstream unavailability degrades truthfully instead of throwing at probe time", async () => {
  const adapter = new The402Adapter();
  const down = stubFetch(() => new CommerceError("UPSTREAM_UNAVAILABLE", "HTTP 503"));
  const probe = await adapter.health(ctx(down.fetch));
  assert.equal(probe.status, "unreachable");
  assert.equal(probe.errorCode, "UPSTREAM_UNAVAILABLE");

  const malformed = stubFetch(() => new CommerceError("UPSTREAM_MALFORMED", "bad json"));
  assert.equal((await adapter.health(ctx(malformed.fetch))).status, "degraded");
});

test("the402: malformed, 429 and timeout propagate as typed errors from discovery", async () => {
  const adapter = new The402Adapter();
  const bad = stubFetch(() => MALFORMED_CATALOG);
  await assert.rejects(() => adapter.discoverServices({}, ctx(bad.fetch)), /UPSTREAM_MALFORMED/);
  for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_RATE_LIMITED"] as const) {
    const stub = stubFetch(() => new CommerceError(code, "boom"));
    await assert.rejects(() => adapter.discoverServices({}, ctx(stub.fetch)), new RegExp(code));
  }
});

test("the402: a service without a usable endpoint is skipped", () => {
  for (const bad of [
    { id: "x" },
    { id: "x", endpoint: "" },
    { id: "x", endpoint: "not a url" },
    { id: "x", endpoint: "ftp://example.com/x" },
    { endpoint: "https://example.com/x" },
  ]) {
    assert.equal(normalizeThe402Service(bad, bareCtx(), "https://x/y"), null);
  }
});

test("the402: quote is never executable", async () => {
  const stub = stubFetch(() => CATALOG_RESPONSE);
  const quote = await new The402Adapter().quote("svc_81153beeef3341c6", ctx(stub.fetch));
  assert.equal(quote.executable, false);
  assert.equal(quote.price?.decimal, "2.75");
  assert.equal(quote.protocol, "the402");
});

test("the402: the adapter never calls a purchase or provider-write endpoint", () => {
  const source = readFileSync(new URL("../src/adapters/the402/index.ts", import.meta.url), "utf8");

  // Every outbound call must be a bare single-argument read. This is stricter
  // than grepping for 'method: "POST"', which would false-positive on the
  // canonical service model's own method field: the402 services genuinely are
  // POST endpoints, so that string legitimately appears as normalized *data*
  // rather than as a request this adapter issues.
  // `[^(]*` skips an optional generic argument list, which may itself contain
  // nested angle brackets such as <Record<string, unknown>>.
  const callPattern = /context\.fetch\.(?:json|text)[^(]*\(/g;
  let match: RegExpExecArray | null;
  let callCount = 0;
  while ((match = callPattern.exec(source)) !== null) {
    callCount += 1;
    // Walk forward from the opening paren, tracking depth, to capture the exact
    // argument list. A regex cannot do this: real call sites span lines and the
    // argument itself contains nested parentheses.
    let depth = 0;
    let args = "";
    for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
      const ch = source[i] as string;
      if (ch === "(") {
        depth += 1;
        if (depth === 1) continue;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      args += ch;
    }
    // A top-level comma means a second argument, i.e. a request init. A trailing
    // comma from a multi-line call is formatting, not an argument, so drop it.
    args = args.trim().replace(/,\s*$/, "");
    let nested = 0;
    for (const ch of args) {
      if (ch === "(" || ch === "{" || ch === "[") nested += 1;
      else if (ch === ")" || ch === "}" || ch === "]") nested -= 1;
      else if (ch === "," && nested === 0) {
        assert.fail(
          `every fetch call must pass only a URL; found a second argument in: ${args.trim()}`,
        );
      }
    }
  }
  assert.ok(callCount > 0, "the adapter should make at least one read call");

  // No request init keys anywhere: no method override, no body, no headers.
  for (const forbidden of ["method:", "body:", "headers:"]) {
    assert.equal(
      new RegExp(`context\\.fetch\\.[^;]*${forbidden}`, "s").test(source),
      false,
      `no fetch call may supply ${forbidden}`,
    );
  }

  for (const forbidden of [
    "/v1/services/purchase",
    "/v1/inquiries",
    "/v1/threads",
    "/v1/balance",
    "/v1/providers",
  ]) {
    assert.equal(source.includes(forbidden), false, `source must not target ${forbidden}`);
  }
});

test("the402: capabilities mark it read-only with no purchase preparation of its own", () => {
  const caps = new The402Adapter().capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.discoverServices, true);
  assert.equal(caps.quote, true);
  assert.equal(caps.preparePurchase, false);
  assert.equal(caps.walletless, true);
});
