import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  PipRailAdapter,
  normalizePipRailResource,
  type PipRailDiscoveryClient,
} from "../src/adapters/piprail/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  DISCOVER_RESULTS,
  EMPTY_DISCOVER_RESULTS,
  MALFORMED_DISCOVER_RESULT,
} from "./fixtures/piprail/responses.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

const noFetch: SafeFetch = {
  json: async () => {
    throw new Error("PipRail adapter must not use raw HTTP in these tests");
  },
  text: async () => {
    throw new Error("PipRail adapter must not use raw HTTP in these tests");
  },
};

function ctx(): AdapterContext {
  return {
    fetch: noFetch,
    evidence: new EvidenceCollector("piprail", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

/** A fake walletless client that records which methods were touched. */
function fakeClient(result: unknown): {
  factory: () => Promise<PipRailDiscoveryClient>;
  calls: string[];
} {
  const calls: string[] = [];
  const client: PipRailDiscoveryClient = {
    discover: async (options) => {
      calls.push(`discover:${String(options.network)}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { factory: async () => client, calls };
}

test("piprail: walletless discovery normalizes resources and rails", async () => {
  const { factory, calls } = fakeClient(DISCOVER_RESULTS);
  const adapter = new PipRailAdapter(factory);
  const services = await adapter.discoverServices({}, ctx());

  // The broken "not-a-url" entry is skipped, not fatal.
  assert.equal(services.length, 3);
  assert.deepEqual(calls, ["discover:any"]);

  const profiler = services.find((s) => s.resourceUrl.includes("profiler.example"));
  assert.ok(profiler);
  assert.equal(profiler?.network, "eip155:84532");
  assert.equal(profiler?.price?.atomic, "20000");
  assert.equal(profiler?.price?.decimal, "0.02");
  assert.equal(profiler?.payTo, "0x000000000000000000000000000000000000bEEF");
  assert.equal(profiler?.actionability.canPurchase, false);
});

test("piprail: multiple rails select the cheapest exact scheme", async () => {
  const { factory } = fakeClient(DISCOVER_RESULTS);
  const services = await new PipRailAdapter(factory).discoverServices({}, ctx());
  const erc20 = services.find((s) => s.resourceUrl.includes("onesource.example"));
  assert.equal(erc20?.price?.atomic, "3000");
  assert.equal(erc20?.network, "eip155:8453");
});

test("piprail: a resource with no rails has an unknown price", async () => {
  const { factory } = fakeClient(DISCOVER_RESULTS);
  const services = await new PipRailAdapter(factory).discoverServices({}, ctx());
  const norails = services.find((s) => s.resourceUrl.includes("norails.example"));
  assert.ok(norails);
  assert.equal(norails?.price, undefined);
  assert.equal(norails?.actionability.canQuote, false);
});

test("piprail: the inferred HTTP method is recorded as inferred, not observed", () => {
  const context = ctx();
  const service = normalizePipRailResource(DISCOVER_RESULTS[1]!, context, "piprail:discover");
  assert.equal(service?.method, "POST");
  const methodEvidence = service?.evidence.find((e) => e.fact === "method");
  assert.equal(methodEvidence?.classification, "inferred");
});

test("piprail: a caller-supplied network narrows the discover call", async () => {
  const { factory, calls } = fakeClient(DISCOVER_RESULTS);
  await new PipRailAdapter(factory).discoverServices({ network: "eip155:84532" }, ctx());
  assert.deepEqual(calls, ["discover:eip155:84532"]);
});

test("piprail: an empty discovery is success with zero results", async () => {
  const { factory } = fakeClient(EMPTY_DISCOVER_RESULTS);
  assert.deepEqual(await new PipRailAdapter(factory).discoverServices({}, ctx()), []);
});

test("piprail: a malformed discovery result raises UPSTREAM_MALFORMED", async () => {
  const { factory } = fakeClient(MALFORMED_DISCOVER_RESULT);
  await assert.rejects(
    () => new PipRailAdapter(factory).discoverServices({}, ctx()),
    /UPSTREAM_MALFORMED/,
  );
});

test("piprail: an SDK that cannot be imported degrades rather than failing hard", async () => {
  const adapter = new PipRailAdapter(async () => {
    throw new CommerceError("ADAPTER_DISABLED", "@piprail/sdk missing");
  });
  const probe = await adapter.health(ctx());
  assert.equal(probe.status, "degraded");
  assert.equal(probe.errorCode, "ADAPTER_DISABLED");
});

test("piprail: preparePurchase fails closed with WALLET_REQUIRED and pays nothing", async () => {
  const { factory, calls } = fakeClient(DISCOVER_RESULTS);
  const adapter = new PipRailAdapter(factory);
  const prepared = await adapter.preparePurchase("https://profiler.example/v1/profile", ctx());

  assert.equal(prepared.walletRequired, true);
  assert.equal(prepared.walletPresent, false);
  assert.equal(prepared.blockedReason, "WALLET_REQUIRED");
  assert.equal(prepared.planPaymentCalled, false);
  assert.equal(prepared.price !== null, true, "the facts an intent needs are still returned");
  // Only discovery was called; no pay/plan method was touched.
  for (const call of calls) {
    assert.match(call, /^discover:/, `unexpected client call ${call}`);
  }
});

test("piprail: preparePublish prepares metadata but never registers", async () => {
  const { factory, calls } = fakeClient(DISCOVER_RESULTS);
  const prepared = await new PipRailAdapter(factory).preparePublish(
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
    ctx(),
  );
  assert.equal(prepared.metadataPrepared, true);
  assert.equal(prepared.registrationPerformed, false);
  assert.match(String(prepared.registrationNote), /EXTERNAL_WRITE/);
  assert.deepEqual(calls, [], "preparePublish must not call the client at all");
});

test("piprail: the injected client type has no paying method to call", () => {
  // Compile-time guarantee made explicit at runtime: the seam exposes only
  // discover and an optional quote.
  const client: PipRailDiscoveryClient = { discover: async () => [] };
  const keys = Object.keys(client);
  assert.deepEqual(keys, ["discover"]);
  for (const forbidden of ["pay", "payExactRail", "payUptoRail", "planPayment", "register"]) {
    assert.equal(forbidden in client, false, `seam must not expose ${forbidden}`);
  }
});

test("piprail: the adapter source never calls a paying, planning or registering method", () => {
  const source = readFileSync(new URL("../src/adapters/piprail/index.ts", import.meta.url), "utf8");
  // Method invocations that would move value or mutate external state.
  for (const forbidden of [
    ".planPayment(",
    ".canAfford(",
    ".payExactRail(",
    ".payUptoRail(",
    ".payAndConfirm(",
    ".register(",
    ".claimDomain(",
    ".verifyDomain(",
    ".authorize(",
    ".retryWithProof(",
    "autoRoute",
  ]) {
    assert.equal(source.includes(forbidden), false, `source must not call ${forbidden}`);
  }
  // The key must never be read or assigned; naming it in prose is acceptable.
  assert.equal(source.includes("process.env.PIPRAIL_PRIVATE_KEY"), false);
  assert.equal(/PIPRAIL_PRIVATE_KEY\s*[:=]\s*["'`]/.test(source), false);
});

test("piprail: capabilities declare walletless and no live execution", () => {
  const caps = new PipRailAdapter(async () => ({ discover: async () => [] })).capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.walletless, true);
  assert.equal(caps.preparePurchase, true);
  assert.ok((caps.notes ?? []).some((n) => n.includes("no private key")));
});
