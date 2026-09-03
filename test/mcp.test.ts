/**
 * MCP surface contract tests.
 *
 * The MCP server is the interface Hermes actually drives, so its tool list is
 * the real security boundary. These tests pin it shut:
 *
 *  - the exposed tool set is EXACTLY the eleven canonical tools;
 *  - no live financial or external-write tool name exists, and any tool whose
 *    name mentions purchase, claim or publish must be a `commerce_prepare_*`
 *    tool, so a live variant cannot be added without failing here;
 *  - every tool carries an explicit read-only / local-write / preparation-only
 *    label and an input schema;
 *  - stdout is reserved for the MCP protocol, so the server source may not write
 *    to it directly.
 *
 * The behavioural tests run a real client and server over an in-memory
 * transport with fake adapters, so nothing here opens a socket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCommerceMcpServer,
  MCP_TOOL_NAMES,
  type CommerceMcpDeps,
} from "../src/mcp/server.js";
import { capabilities } from "../src/core/capabilities.js";
import { CommerceError } from "../src/core/errors.js";
import { modeAServiceActionability, modeAWorkActionability } from "../src/core/models.js";
import type { CommerceAdapter } from "../src/adapters/interface.js";

const AT = "2026-08-19T00:00:00.000Z";
const CLOCK = (): string => AT;
const SVC_ID = "svc_0000000000000000000000000000000a";
const WRK_ID = "wrk_0000000000000000000000000000000a";

const EXPECTED_TOOLS: readonly string[] = [
  "commerce_sources",
  "commerce_status",
  "commerce_discover_services",
  "commerce_discover_work",
  "commerce_inspect",
  "commerce_quote",
  "commerce_prepare_purchase",
  "commerce_prepare_claim",
  "commerce_prepare_publish",
  "commerce_probe",
  "commerce_export_evidence",
];

/**
 * Tool names that would represent a live action.
 *
 * `piprail_pay_request` is listed explicitly because the PipRail SDK exposes a
 * payment request primitive, and the whole point of the walletless adapter is
 * that it never becomes a tool.
 */
const FORBIDDEN_TOOL_NAMES: readonly string[] = [
  "pay",
  "purchase",
  "buy",
  "claim",
  "submit",
  "settle",
  "send",
  "transfer",
  "withdraw",
  "fund",
  "publish",
  "execute",
  "broadcast",
  "sign",
  "register",
  "commerce_pay",
  "commerce_purchase",
  "commerce_buy",
  "commerce_claim",
  "commerce_submit",
  "commerce_settle",
  "commerce_send",
  "commerce_transfer",
  "commerce_withdraw",
  "commerce_fund",
  "commerce_publish",
  "commerce_execute",
  "commerce_sign",
  "commerce_register",
  "piprail_pay_request",
  "piprail_pay",
  "x402_settle",
  "coinbase_transfer",
  "usdc_transfer",
];

// ------------------------------------------------------------------ fixtures

function fakeService(id: string, price: string) {
  return {
    id,
    kind: "service" as const,
    sources: [{ source: "cdp_bazaar" as const, externalId: "ext-1", observedAt: AT }],
    name: "fake-service",
    resourceUrl: "https://api.example.com/v1/thing",
    method: "POST",
    protocol: "x402",
    network: "eip155:84532",
    price: { atomic: "20000", decimal: price, usd: price, currency: "USDC" },
    payTo: "0x000000000000000000000000000000000000bEEF",
    health: "ok" as const,
    observedAt: AT,
    tags: ["data"],
    evidence: [],
    actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
  };
}

function fakeWork(id: string) {
  return {
    id,
    kind: "work" as const,
    source: "agent_bounties" as const,
    externalId: "bounty-7",
    title: "Fix a flaky test",
    reward: { amount: "5", asset: "USDC", usd: "5" },
    funding: { state: "funded" as const, evidence: "observed" as const },
    verification: { type: "deterministic" as const },
    requirements: ["tests must pass"],
    status: "open" as const,
    observedAt: AT,
    evidence: [],
    actionability: modeAWorkActionability({ canPrepareClaim: true }),
  };
}

const serviceAdapter: CommerceAdapter = {
  id: "cdp_bazaar",
  capabilities: () =>
    capabilities({ discoverServices: true, inspect: true, quote: true, preparePurchase: true }),
  health: async () => ({ platform: "cdp_bazaar", status: "ok", checkedAt: AT }),
  discoverServices: async () => [fakeService(SVC_ID, "0.02")],
  inspect: async (externalId) => ({
    platform: "cdp_bazaar",
    externalId,
    inspectedAt: AT,
    service: fakeService(SVC_ID, "0.02"),
    evidence: [],
  }),
  quote: async () => ({
    serviceId: SVC_ID,
    platform: "cdp_bazaar",
    resourceUrl: "https://api.example.com/v1/thing",
    method: "POST",
    protocol: "x402",
    network: "eip155:84532",
    price: { atomic: "20000", decimal: "0.02", usd: "0.02" },
    payTo: "0x000000000000000000000000000000000000bEEF",
    quotedAt: AT,
    evidence: [],
    executable: false as const,
  }),
  preparePurchase: async () => ({
    platform: "cdp_bazaar",
    resourceUrl: "https://api.example.com/v1/thing",
    method: "POST",
    protocol: "x402",
    network: "eip155:84532",
    asset: { symbol: "USDC", decimals: 6 },
    price: { atomic: "20000", decimal: "0.02", usd: "0.02" },
    payTo: "0x000000000000000000000000000000000000bEEF",
    settlementNote: "settlement needs a signer; disabled in Mode A",
  }),
};

const workAdapter: CommerceAdapter = {
  id: "agent_bounties",
  capabilities: () => capabilities({ discoverWork: true, inspect: true, prepareClaim: true }),
  health: async () => ({ platform: "agent_bounties", status: "ok", checkedAt: AT }),
  discoverWork: async () => [fakeWork(WRK_ID)],
  inspect: async (externalId) => ({
    platform: "agent_bounties",
    externalId,
    inspectedAt: AT,
    work: fakeWork(WRK_ID),
    evidence: [],
  }),
  prepareClaim: async () => ({
    platform: "agent_bounties",
    title: "Fix a flaky test",
    reward: { amount: "5", asset: "USDC" },
    funding: { state: "funded", evidence: "observed" },
    verification: { type: "deterministic" },
    requirements: ["tests must pass"],
    externalStepsRequired: ["sign a claim plan"],
    blockedReason: "EXTERNAL_WRITE_DISABLED",
  }),
};

const brokenAdapter: CommerceAdapter = {
  id: "the402",
  capabilities: () => capabilities({ discoverServices: true }),
  health: async () => {
    throw new CommerceError("UPSTREAM_UNAVAILABLE", "the402 is down");
  },
  discoverServices: async () => {
    throw new CommerceError("UPSTREAM_UNAVAILABLE", "the402 is down");
  },
};

const ALL: readonly CommerceAdapter[] = [serviceAdapter, workAdapter, brokenAdapter];

// ------------------------------------------------------------------- harness

interface Roots {
  readonly env: Record<string, string | undefined>;
  readonly cleanup: () => void;
}

function tempRoots(): Roots {
  const root = mkdtempSync(join(tmpdir(), "hermes-mcp-test-"));
  return {
    env: {
      COMMERCE_STATE_ROOT: join(root, "state"),
      COMMERCE_REPO_ROOT: join(root, "repo"),
    },
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ToolResult {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
  readonly content?: unknown;
}

/** Runs a client and server over a linked in-memory transport pair. */
async function withServer<T>(
  deps: CommerceMcpDeps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCommerceMcpServer({ clock: CLOCK, ...deps });
  const client = new Client({ name: "hermes-commerce-control-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Extracts the single JSON envelope a tool returns. */
function envelopeOf(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent as Record<string, unknown>;
  }
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  assert.ok(first !== undefined, "tool returned no content");
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined, "tool returned no text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function dataOf(result: ToolResult): Record<string, unknown> {
  const envelope = envelopeOf(result);
  assert.equal(envelope.ok, true, `tool reported failure: ${JSON.stringify(envelope.error)}`);
  return envelope.data as Record<string, unknown>;
}

/**
 * Raw first text block.
 *
 * A protocol-level refusal (bad arguments, unknown tool) carries a plain message
 * rather than our JSON envelope, so it needs a separate accessor.
 */
function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  assert.ok(first !== undefined, "tool returned no content");
  return first.text ?? "";
}

/** Local intent count, used to prove a refused call changed nothing. */
async function intentCount(client: Client): Promise<number> {
  const result = (await client.callTool({
    name: "commerce_status",
    arguments: {},
  })) as ToolResult;
  const counts = dataOf(result).counts as Record<string, number>;
  return counts.intents ?? -1;
}

// -------------------------------------------------------------- enumeration

test("MCP: the exported tool-name constant is exactly the canonical set", () => {
  assert.deepEqual([...MCP_TOOL_NAMES].sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(MCP_TOOL_NAMES.length, 11);
});

test("MCP: a live client sees exactly the eleven canonical tools", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: no live financial or external-write tool is exposed", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const listed = await client.listTools();
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const forbidden of FORBIDDEN_TOOL_NAMES) {
        assert.equal(names.has(forbidden), false, `forbidden tool exposed: ${forbidden}`);
      }
      // Structural rule: an action verb may only appear behind the preparation
      // prefix, so a live sibling cannot be introduced silently.
      for (const name of names) {
        if (/purchase|claim|publish/.test(name)) {
          assert.ok(
            name.startsWith("commerce_prepare_"),
            `action tool ${name} must be a preparation tool`,
          );
        }
      }
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: every tool declares a safety label and an input schema", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const description = tool.description ?? "";
        assert.ok(
          /read-only|local-write|preparation-only/.test(description),
          `tool ${tool.name} lacks a safety label`,
        );
        assert.ok(tool.inputSchema !== undefined, `tool ${tool.name} lacks an input schema`);
        assert.equal(tool.inputSchema.type, "object");
      }
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: preparation tools are labelled preparation-only and non-destructive", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        if (!tool.name.startsWith("commerce_prepare_")) continue;
        assert.match(tool.description ?? "", /preparation-only/);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: the server source never writes to stdout directly", () => {
  const source = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  // stdout belongs to the MCP transport; a stray write corrupts the protocol.
  assert.equal(source.includes("console.log"), false);
  assert.equal(source.includes("process.stdout"), false);
});

// -------------------------------------------------------------- behavioural

test("MCP: commerce_status reports Mode A with both gates false", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_status",
        arguments: {},
      })) as ToolResult;
      const data = dataOf(result);
      assert.equal(data.mode, "A");
      assert.equal(data.externalWritesEnabled, false);
      assert.equal(data.liveValueMovementEnabled, false);
      assert.equal(data.walletSecretPresent, false);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_sources lists all seven platforms", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_sources",
        arguments: {},
      })) as ToolResult;
      const data = dataOf(result);
      assert.equal(data.count, 7);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_discover_services ranks results and isolates a broken source", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_discover_services",
        arguments: { query: "profiler" },
      })) as ToolResult;
      const data = dataOf(result);
      const results = data.results as Array<Record<string, unknown>>;
      assert.equal(results.length, 1);
      assert.equal(data.degraded, true);
      const sources = data.sources as Record<string, Record<string, unknown>>;
      assert.equal(sources.the402?.status, "unreachable");
      const service = results[0]?.service as Record<string, unknown>;
      const actionability = service.actionability as Record<string, unknown>;
      assert.equal(actionability.canPurchase, false);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_discover_work returns earnable work with live claim disabled", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_discover_work",
        arguments: {},
      })) as ToolResult;
      const data = dataOf(result);
      const results = data.results as Array<Record<string, unknown>>;
      assert.equal(results.length, 1);
      const work = results[0]?.work as Record<string, unknown>;
      const actionability = work.actionability as Record<string, unknown>;
      assert.equal(actionability.canClaim, false);
      assert.equal(actionability.canSubmit, false);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_inspect and commerce_quote never produce an executable quote", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const inspected = (await client.callTool({
        name: "commerce_inspect",
        arguments: { target: "cdp_bazaar:ext-1" },
      })) as ToolResult;
      assert.equal(dataOf(inspected).platform, "cdp_bazaar");

      const quoted = (await client.callTool({
        name: "commerce_quote",
        arguments: { target: "cdp_bazaar:ext-1" },
      })) as ToolResult;
      const quote = dataOf(quoted).quote as Record<string, unknown>;
      assert.equal(quote.executable, false);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_prepare_purchase succeeds and returns a blocked intent", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_prepare_purchase",
        arguments: { target: "cdp_bazaar:ext-1" },
      })) as ToolResult;
      // A correct refusal is a successful preparation, not a tool error.
      assert.notEqual(result.isError, true);
      const data = dataOf(result);
      const intent = data.intent as Record<string, unknown>;
      assert.equal(intent.kind, "payment");
      assert.equal(intent.financialActionExecuted, false);
      assert.equal(intent.signerPresent, false);
      assert.equal(intent.walletPresent, false);
      const decision = intent.decision as Record<string, unknown>;
      assert.equal(decision.decision, "block");
      assert.equal(decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
      assert.equal(decision.requiredActivation, "B2");
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_prepare_claim blocks the external write", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_prepare_claim",
        arguments: { target: "agent_bounties:bounty-7" },
      })) as ToolResult;
      const intent = dataOf(result).intent as Record<string, unknown>;
      assert.equal(intent.claimBroadcast, false);
      assert.equal(intent.submissionBroadcast, false);
      const decision = intent.decision as Record<string, unknown>;
      assert.equal(decision.reason, "EXTERNAL_WRITE_DISABLED");
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_prepare_publish never publishes", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_prepare_publish",
        arguments: { product: "data-quality-profiler" },
      })) as ToolResult;
      const data = dataOf(result);
      const readiness = data.readiness as Record<string, unknown>;
      assert.equal(readiness.publicationAllowed, false);
      assert.equal(readiness.publicationExecuted, false);
      const intents = data.intents as Array<Record<string, unknown>>;
      assert.ok(intents.length >= 1);
      for (const intent of intents) {
        assert.equal(intent.registrationPerformed, false);
        assert.equal(intent.publicationPerformed, false);
      }
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_probe records health without failing on an outage", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_probe",
        arguments: {},
      })) as ToolResult;
      const probes = dataOf(result).probes as Array<Record<string, unknown>>;
      assert.equal(probes.length, 3);
      const byPlatform = new Map(probes.map((p) => [p.platform, p.status]));
      assert.equal(byPlatform.get("cdp_bazaar"), "ok");
      assert.equal(byPlatform.get("the402"), "unreachable");
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: commerce_export_evidence writes artifacts with real checksums", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      await client.callTool({ name: "commerce_discover_services", arguments: { query: "x" } });
      const result = (await client.callTool({
        name: "commerce_export_evidence",
        arguments: {},
      })) as ToolResult;
      const artifacts = dataOf(result).artifacts as Array<Record<string, unknown>>;
      assert.ok(artifacts.length >= 4);
      for (const artifact of artifacts) {
        assert.match(artifact.sha256 as string, /^[0-9a-f]{64}$/);
      }
    });
  } finally {
    roots.cleanup();
  }
});

// -------------------------------------------------------------- error paths

test("MCP: an unresolvable target is a tool error, not a transport crash", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_inspect",
        arguments: { target: "svc_ffffffffffffffffffffffffffffffff" },
      })) as ToolResult;
      assert.equal(result.isError, true);
      const envelope = envelopeOf(result);
      assert.equal(envelope.ok, false);
      const error = envelope.error as Record<string, unknown>;
      assert.equal(error.code, "NOT_FOUND");
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: a wrongly typed argument is refused by the input schema", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_inspect",
        arguments: { target: 42 },
      })) as ToolResult;
      assert.equal(result.isError, true, "a non-string target must not be accepted");
      assert.match(textOf(result), /validation error/i);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: a missing required argument is refused rather than defaulted", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_prepare_purchase",
        arguments: {},
      })) as ToolResult;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /validation error/i);
      // The refused call must not have produced an intent.
      assert.equal(await intentCount(client), 0);
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: prepare publish refuses an unknown product and prepares nothing", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      const result = (await client.callTool({
        name: "commerce_prepare_publish",
        arguments: { product: "some-other-product" },
      })) as ToolResult;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /data-quality-profiler/);
      assert.equal(await intentCount(client), 0, "a refused publication must persist no intent");
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: a live-action tool name does not exist", async () => {
  const roots = tempRoots();
  try {
    await withServer({ env: roots.env, adapters: ALL }, async (client) => {
      for (const name of ["commerce_pay", "commerce_purchase", "commerce_claim", "piprail_pay_request"]) {
        const result = (await client.callTool({ name, arguments: {} })) as ToolResult;
        assert.equal(result.isError, true, `${name} must not be callable`);
        assert.match(textOf(result), /not found/i);
      }
    });
  } finally {
    roots.cleanup();
  }
});

test("MCP: a Mode-B activation attempt fails closed through the MCP surface", async () => {
  const roots = tempRoots();
  try {
    await withServer(
      {
        env: { ...roots.env, EXTERNAL_WRITES_ENABLED: "true" },
        adapters: ALL,
      },
      async (client) => {
        const result = (await client.callTool({
          name: "commerce_status",
          arguments: {},
        })) as ToolResult;
        assert.equal(result.isError, true);
        const error = envelopeOf(result).error as Record<string, unknown>;
        assert.equal(error.code, "CONFIG_ERROR");
      },
    );
  } finally {
    roots.cleanup();
  }
});
