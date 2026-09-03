import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { capabilities } from "../src/core/capabilities.js";
import { CommerceError } from "../src/core/errors.js";
import { modeAServiceActionability } from "../src/core/models.js";
import type { CommerceAdapter, AdapterContext } from "../src/adapters/interface.js";
import { AdapterRegistry } from "../src/adapters/registry.js";

const cfg = loadConfig({});

function fakeService(id: string, source: "cdp_bazaar" | "agent402" | "the402") {
  return {
    id,
    kind: "service" as const,
    sources: [{ source, externalId: "x", observedAt: "2026-08-19T00:00:00.000Z" }],
    name: "fake",
    resourceUrl: "https://api.example.com/v1/x",
    method: "POST",
    protocol: "x402",
    health: "ok" as const,
    observedAt: "2026-08-19T00:00:00.000Z",
    tags: [],
    evidence: [],
    actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
  };
}

const okAdapter: CommerceAdapter = {
  id: "cdp_bazaar",
  capabilities: () => capabilities({ discoverServices: true }),
  health: async () => ({
    platform: "cdp_bazaar",
    status: "ok",
    checkedAt: "2026-08-19T00:00:00.000Z",
  }),
  discoverServices: async () => [fakeService("svc_00000000000000000000000000000001", "cdp_bazaar")],
};

const throwingAdapter: CommerceAdapter = {
  id: "the402",
  capabilities: () => capabilities({ discoverServices: true }),
  health: async () => ({
    platform: "the402",
    status: "unreachable",
    checkedAt: "2026-08-19T00:00:00.000Z",
  }),
  discoverServices: async () => {
    throw new CommerceError("UPSTREAM_UNAVAILABLE", "the402 is down");
  },
};

const emptyAdapter: CommerceAdapter = {
  id: "agent402",
  capabilities: () => capabilities({ discoverServices: true }),
  health: async () => ({
    platform: "agent402",
    status: "ok",
    checkedAt: "2026-08-19T00:00:00.000Z",
  }),
  discoverServices: async () => [],
};

test("registry: one failing source does not fail aggregate discovery", async () => {
  const registry = new AdapterRegistry(cfg, [okAdapter, throwingAdapter, emptyAdapter]);
  const result = await registry.discoverServices({});

  // All three sources are reported.
  assert.deepEqual(Object.keys(result.sources).sort(), ["agent402", "cdp_bazaar", "the402"]);
  assert.equal(result.sources.cdp_bazaar?.status, "ok");
  assert.equal(result.sources.cdp_bazaar?.count, 1);
  // Healthy with zero results is success, not failure.
  assert.equal(result.sources.agent402?.status, "ok");
  assert.equal(result.sources.agent402?.count, 0);
  // The failure is typed and isolated.
  assert.equal(result.sources.the402?.status, "unreachable");
  assert.equal(result.sources.the402?.error, "UPSTREAM_UNAVAILABLE");
  // The working source's result survives.
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.id, "svc_00000000000000000000000000000001");
});

test("registry: every source reports a duration", async () => {
  const registry = new AdapterRegistry(cfg, [okAdapter, throwingAdapter, emptyAdapter]);
  const result = await registry.discoverServices({});
  for (const [name, status] of Object.entries(result.sources)) {
    assert.equal(typeof status.durationMs, "number", `${name} missing durationMs`);
    assert.ok(status.durationMs >= 0);
  }
});

test("registry: a disabled adapter reports disabled and is not invoked", async () => {
  let invoked = false;
  const spy: CommerceAdapter = {
    ...okAdapter,
    id: "the402",
    discoverServices: async () => {
      invoked = true;
      return [];
    },
  };
  const disabledCfg = loadConfig({ COMMERCE_DISABLE_THE402: "true" });
  const registry = new AdapterRegistry(disabledCfg, [spy]);
  const result = await registry.discoverServices({});
  assert.equal(result.sources.the402?.status, "disabled");
  assert.equal(invoked, false, "a disabled adapter must not be invoked");
});

test("registry: an undeclared operation is never invoked", async () => {
  let invoked = false;
  const liar: CommerceAdapter = {
    id: "piprail",
    // Declares no discoverServices capability...
    capabilities: () => capabilities({ inspect: true }),
    health: async () => ({
      platform: "piprail",
      status: "ok",
      checkedAt: "2026-08-19T00:00:00.000Z",
    }),
    // ...but implements it anyway.
    discoverServices: async () => {
      invoked = true;
      return [];
    },
  };
  const registry = new AdapterRegistry(cfg, [liar]);
  const result = await registry.discoverServices({});
  assert.equal(invoked, false, "capability gate must prevent the call");
  assert.equal(result.sources.piprail?.status, "disabled");
});

test("registry: concurrency never exceeds the configured limit", async () => {
  let active = 0;
  let peak = 0;
  const make = (id: "cdp_bazaar" | "agent402" | "the402" | "piprail" | "paysh"): CommerceAdapter => ({
    id,
    capabilities: () => capabilities({ discoverServices: true }),
    health: async () => ({ platform: id, status: "ok", checkedAt: "2026-08-19T00:00:00.000Z" }),
    discoverServices: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return [];
    },
  });
  const registry = new AdapterRegistry(cfg, [
    make("cdp_bazaar"),
    make("agent402"),
    make("the402"),
    make("piprail"),
    make("paysh"),
  ]);
  await registry.discoverServices({});
  assert.ok(peak <= cfg.concurrency, `peak concurrency ${peak} exceeded ${cfg.concurrency}`);
});

test("registry: a hanging adapter is bounded by the adapter budget", async () => {
  const hanger: CommerceAdapter = {
    id: "bountybook",
    capabilities: () => capabilities({ discoverWork: true }),
    health: async () => ({
      platform: "bountybook",
      status: "ok",
      checkedAt: "2026-08-19T00:00:00.000Z",
    }),
    discoverWork: async (_q, ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 10_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new CommerceError("UPSTREAM_TIMEOUT", "aborted"));
        });
      });
      return [];
    },
  };
  const fastCfg = loadConfig({ COMMERCE_ADAPTER_BUDGET_MS: "1000" });
  const registry = new AdapterRegistry(fastCfg, [hanger]);
  const started = Date.now();
  const result = await registry.discoverWork({});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `registry did not bound a hanging adapter (${elapsed}ms)`);
  assert.notEqual(result.sources.bountybook?.status, "ok");
});

test("registry: adapter context carries no wallet or signing material", async () => {
  let captured: AdapterContext | null = null;
  const inspector: CommerceAdapter = {
    id: "agent402",
    capabilities: () => capabilities({ discoverServices: true }),
    health: async () => ({
      platform: "agent402",
      status: "ok",
      checkedAt: "2026-08-19T00:00:00.000Z",
    }),
    discoverServices: async (_q, ctx) => {
      captured = ctx;
      return [];
    },
  };
  const registry = new AdapterRegistry(cfg, [inspector]);
  await registry.discoverServices({});
  assert.ok(captured !== null);
  const ctx = captured as unknown as Record<string, unknown>;
  for (const forbidden of [
    "wallet",
    "signer",
    "privateKey",
    "mnemonic",
    "account",
    "credentials",
    "secret",
  ]) {
    assert.equal(forbidden in ctx, false, `context must not expose ${forbidden}`);
  }
  // It must expose the safe primitives.
  for (const expected of ["fetch", "evidence", "clock", "signal", "config"]) {
    assert.ok(expected in ctx, `context should expose ${expected}`);
  }
  const serialized = JSON.stringify(Object.keys(ctx));
  assert.equal(serialized.toLowerCase().includes("key"), false);
});

test("registry: health probes all sources without failing on one", async () => {
  const registry = new AdapterRegistry(cfg, [okAdapter, throwingAdapter, emptyAdapter]);
  const probes = await registry.probeAll();
  assert.equal(probes.length, 3);
  const byPlatform = new Map(probes.map((p) => [p.platform, p]));
  assert.equal(byPlatform.get("cdp_bazaar")?.status, "ok");
  assert.equal(byPlatform.get("the402")?.status, "unreachable");
});

test("registry: a health probe that throws becomes an unreachable probe", async () => {
  const broken: CommerceAdapter = {
    id: "paysh",
    capabilities: () => capabilities({ discoverServices: true }),
    health: async () => {
      throw new Error("boom");
    },
  };
  const registry = new AdapterRegistry(cfg, [broken]);
  const probes = await registry.probeAll();
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.status, "unreachable");
  assert.equal(probes[0]?.platform, "paysh");
});

test("registry: results from a source that returns a malformed candidate are dropped", async () => {
  const malformed: CommerceAdapter = {
    id: "the402",
    capabilities: () => capabilities({ discoverServices: true }),
    health: async () => ({
      platform: "the402",
      status: "ok",
      checkedAt: "2026-08-19T00:00:00.000Z",
    }),
    // Attempts to emit a candidate with live purchase enabled.
    discoverServices: async () =>
      [
        {
          ...fakeService("svc_00000000000000000000000000000002", "the402"),
          actionability: { canQuote: true, canPreparePurchase: true, canPurchase: true },
        },
      ] as never,
  };
  const registry = new AdapterRegistry(cfg, [malformed]);
  const result = await registry.discoverServices({});
  assert.equal(result.results.length, 0, "a candidate claiming canPurchase must be rejected");
  assert.equal(result.sources.the402?.status, "degraded");
});
