/**
 * CLI contract tests.
 *
 * These assert the *control surface*, not the adapters: fake adapters are
 * injected so no test in this file opens a socket. The properties that matter to
 * a reviewer are:
 *
 *  - the canonical command list exists and nothing outside it is accepted;
 *  - `--json` puts exactly ONE JSON document on stdout and every diagnostic on
 *    stderr, so a machine caller can parse stdout unconditionally;
 *  - preparing a policy-blocked action is a SUCCESSFUL operation (exit 0) whose
 *    JSON carries the block, rather than an error;
 *  - no command name anywhere in the surface can perform a live payment, claim,
 *    submission or production publication.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, CLI_COMMANDS, type CliDeps } from "../src/cli.js";
import { capabilities } from "../src/core/capabilities.js";
import { CommerceError } from "../src/core/errors.js";
import { modeAServiceActionability, modeAWorkActionability } from "../src/core/models.js";
import type { CommerceAdapter } from "../src/adapters/interface.js";

const AT = "2026-08-19T00:00:00.000Z";
const CLOCK = (): string => AT;

const SVC_ID = "svc_0000000000000000000000000000000a";
const SVC_ID_2 = "svc_0000000000000000000000000000000b";
const WRK_ID = "wrk_0000000000000000000000000000000a";

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[], deps: CliDeps = {}): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdout: (chunk: string): void => {
        stdout += chunk;
      },
      stderr: (chunk: string): void => {
        stderr += chunk;
      },
    },
    { clock: CLOCK, ...deps },
  );
  return { code, stdout, stderr };
}

function soleJson(captured: Captured): Record<string, unknown> {
  const trimmed = captured.stdout.trim();
  assert.notEqual(trimmed, "", "stdout was empty; expected one JSON document");
  const parsed: unknown = JSON.parse(trimmed);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return parsed as Record<string, unknown>;
}

function tempRoots(): { env: Record<string, string | undefined>; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hermes-cli-test-"));
  return {
    root,
    env: {
      COMMERCE_STATE_ROOT: join(root, "state"),
      COMMERCE_REPO_ROOT: join(root, "repo"),
    },
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fakeService(id: string, price: string) {
  return {
    id,
    kind: "service" as const,
    sources: [{ source: "cdp_bazaar" as const, externalId: "ext-1", observedAt: AT }],
    name: `service-${id.slice(-1)}`,
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
    capabilities({
      discoverServices: true,
      inspect: true,
      quote: true,
      preparePurchase: true,
    }),
  health: async () => ({ platform: "cdp_bazaar", status: "ok", checkedAt: AT }),
  discoverServices: async () => [fakeService(SVC_ID, "0.02"), fakeService(SVC_ID_2, "0.05")],
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
    paymentProofRule: "Only a settled event proves payment.",
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

test("CLI: the canonical command surface is exactly the documented set", () => {
  assert.deepEqual(
    [...CLI_COMMANDS].sort(),
    [
      "discover services",
      "discover work",
      "doctor",
      "export",
      "inspect",
      "prepare claim",
      "prepare publish",
      "prepare purchase",
      "probe",
      "quote",
      "sources",
      "status",
    ].sort(),
  );
});

test("CLI: no command can perform a live financial or external write action", () => {
  const forbidden =
    /^(pay|purchase|buy|claim|submit|settle|send|transfer|withdraw|fund|execute|broadcast|sign|register|publish)\b/i;
  for (const command of CLI_COMMANDS) {
    assert.equal(forbidden.test(command), false, `forbidden live command: ${command}`);
  }
});

test("CLI: an unknown command is a usage error on stderr, not a crash", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["pay", "svc_x"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 2);
    assert.equal(out.stdout.trim(), "", "usage errors must not pollute stdout");
    assert.match(out.stderr, /unknown command/i);
  } finally {
    roots.cleanup();
  }
});

test("CLI: an unknown command in --json mode still yields one JSON document", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["settle", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 2);
    const doc = soleJson(out);
    assert.equal(doc.ok, false);
    const error = doc.error as Record<string, unknown>;
    assert.equal(error.code, "INVALID_INPUT");
  } finally {
    roots.cleanup();
  }
});

test("CLI: sources lists every platform with capabilities and no network access", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["sources", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const doc = soleJson(out);
    assert.equal(doc.ok, true);
    assert.equal(doc.command, "sources");
    assert.equal(doc.mode, "A");
    const data = doc.data as Record<string, unknown>;
    const sources = data.sources as Array<Record<string, unknown>>;
    assert.equal(sources.length, 7, "all seven platforms must be listed");
    const ids = sources.map((s) => s.platform);
    assert.deepEqual(
      [...ids].sort(),
      [
        "agent402",
        "agent_bounties",
        "bountybook",
        "cdp_bazaar",
        "paysh",
        "piprail",
        "the402",
      ],
    );
    for (const source of sources) {
      const caps = source.capabilities as Record<string, unknown> | undefined;
      if (caps !== undefined) assert.equal(caps.liveExecution, false);
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: sources reflects a configuration disable", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["sources", "--json"], {
      env: { ...roots.env, COMMERCE_DISABLE_THE402: "true" },
      adapters: ALL,
    });
    const data = soleJson(out).data as Record<string, unknown>;
    const sources = data.sources as Array<Record<string, unknown>>;
    const the402 = sources.find((s) => s.platform === "the402");
    assert.equal(the402?.enabled, false);
    const cdp = sources.find((s) => s.platform === "cdp_bazaar");
    assert.equal(cdp?.enabled, true);
  } finally {
    roots.cleanup();
  }
});

test("CLI: status is local-only and proves Mode A with both gates false", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["status", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const doc = soleJson(out);
    const data = doc.data as Record<string, unknown>;
    assert.equal(data.mode, "A");
    assert.equal(data.externalWritesEnabled, false);
    assert.equal(data.liveValueMovementEnabled, false);
    assert.equal(data.walletSecretPresent, false);
    const counts = data.counts as Record<string, unknown>;
    assert.equal(counts.services, 0);
    assert.equal(counts.work, 0);
    assert.equal(counts.intents, 0);
  } finally {
    roots.cleanup();
  }
});

test("CLI: status in human mode writes readable text and no JSON to stdout", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["status"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /mode/i);
    assert.throws(() => JSON.parse(out.stdout.trim()), "human mode must not emit JSON");
  } finally {
    roots.cleanup();
  }
});

test("CLI: discover services ranks deterministically and isolates a broken source", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["discover", "services", "profiler", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const doc = soleJson(out);
    const data = doc.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    const scores = results.map((r) => r.score as number);
    assert.ok(scores[0] !== undefined && scores[1] !== undefined);
    assert.ok((scores[0] as number) >= (scores[1] as number));
    const sources = data.sources as Record<string, Record<string, unknown>>;
    assert.equal(sources.cdp_bazaar?.status, "ok");
    assert.equal(sources.cdp_bazaar?.count, 2);
    assert.equal(sources.the402?.status, "unreachable");
    assert.equal(data.degraded, true);
    for (const result of results) {
      const service = result.service as Record<string, unknown>;
      const actionability = service.actionability as Record<string, unknown>;
      assert.equal(actionability.canPurchase, false);
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: discover services is deterministic across repeated runs", async () => {
  const roots = tempRoots();
  try {
    const first = await run(["discover", "services", "x", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    const second = await run(["discover", "services", "x", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    const a = soleJson(first).data as Record<string, unknown>;
    const b = soleJson(second).data as Record<string, unknown>;
    assert.deepEqual(a.results, b.results);
  } finally {
    roots.cleanup();
  }
});

test("CLI: discover services honours a hard maximum price filter", async () => {
  const roots = tempRoots();
  try {
    const out = await run(
      ["discover", "services", "x", "--max-usd-price", "0.03", "--json"],
      { env: roots.env, adapters: ALL },
    );
    const data = soleJson(out).data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
  } finally {
    roots.cleanup();
  }
});

test("CLI: discover work returns earnable work only", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["discover", "work", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    const work = results[0]?.work as Record<string, unknown>;
    const actionability = work.actionability as Record<string, unknown>;
    assert.equal(actionability.canClaim, false);
    assert.equal(actionability.canSubmit, false);
  } finally {
    roots.cleanup();
  }
});

test("CLI: discovery persists results so status counts rise", async () => {
  const roots = tempRoots();
  try {
    await run(["discover", "services", "x", "--json"], { env: roots.env, adapters: ALL });
    await run(["discover", "work", "--json"], { env: roots.env, adapters: ALL });
    const out = await run(["status", "--json"], { env: roots.env, adapters: ALL });
    const data = soleJson(out).data as Record<string, unknown>;
    const counts = data.counts as Record<string, unknown>;
    assert.equal(counts.services, 2);
    assert.equal(counts.work, 1);
  } finally {
    roots.cleanup();
  }
});

test("CLI: inspect resolves a platform:externalId target", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["inspect", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    assert.equal(data.platform, "cdp_bazaar");
    assert.equal(data.externalId, "ext-1");
    assert.ok(data.service !== undefined);
  } finally {
    roots.cleanup();
  }
});

test("CLI: inspect resolves a canonical ID through persisted state", async () => {
  const roots = tempRoots();
  try {
    await run(["discover", "services", "x", "--json"], { env: roots.env, adapters: ALL });
    const out = await run(["inspect", SVC_ID, "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    assert.equal(data.platform, "cdp_bazaar");
  } finally {
    roots.cleanup();
  }
});

test("CLI: inspect of an unknown target fails with a typed error and exit 1", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["inspect", "svc_ffffffffffffffffffffffffffffffff", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 1);
    const doc = soleJson(out);
    assert.equal(doc.ok, false);
    const error = doc.error as Record<string, unknown>;
    assert.equal(error.code, "NOT_FOUND");
  } finally {
    roots.cleanup();
  }
});

test("CLI: inspect requires a target argument", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["inspect", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 2);
    const doc = soleJson(out);
    assert.equal(doc.ok, false);
  } finally {
    roots.cleanup();
  }
});

test("CLI: a quote is never executable", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["quote", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const quote = data.quote as Record<string, unknown>;
    assert.equal(quote.executable, false);
  } finally {
    roots.cleanup();
  }
});

test("CLI: quote against an adapter that cannot quote is a typed refusal", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["quote", "agent_bounties:bounty-7", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 1);
    const error = soleJson(out).error as Record<string, unknown>;
    assert.equal(error.code, "UNSUPPORTED_OPERATION");
  } finally {
    roots.cleanup();
  }
});

test("CLI: prepare purchase succeeds with exit 0 and carries the policy block", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["prepare", "purchase", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const doc = soleJson(out);
    assert.equal(doc.ok, true);
    const data = soleJson(out).data as Record<string, unknown>;
    const intent = data.intent as Record<string, unknown>;
    assert.equal(intent.kind, "payment");
    assert.equal(intent.financialActionExecuted, false);
    assert.equal(intent.externalMutationExecuted, false);
    assert.equal(intent.signerPresent, false);
    assert.equal(intent.walletPresent, false);
    const decision = intent.decision as Record<string, unknown>;
    assert.equal(decision.decision, "block");
    assert.equal(decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
    assert.equal(decision.requiredActivation, "B2");
  } finally {
    roots.cleanup();
  }
});

test("CLI: prepare claim succeeds with exit 0 and blocks the external write", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["prepare", "claim", "agent_bounties:bounty-7", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const intent = data.intent as Record<string, unknown>;
    assert.equal(intent.kind, "claim");
    assert.equal(intent.claimBroadcast, false);
    assert.equal(intent.submissionBroadcast, false);
    const decision = intent.decision as Record<string, unknown>;
    assert.equal(decision.decision, "block");
    assert.equal(decision.reason, "EXTERNAL_WRITE_DISABLED");
    assert.equal(decision.requiredActivation, "B1");
  } finally {
    roots.cleanup();
  }
});

test("CLI: a prepared intent is persisted and reported by status", async () => {
  const roots = tempRoots();
  try {
    await run(["prepare", "purchase", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    const out = await run(["status", "--json"], { env: roots.env, adapters: ALL });
    const data = soleJson(out).data as Record<string, unknown>;
    const counts = data.counts as Record<string, unknown>;
    assert.equal(counts.intents, 1);
  } finally {
    roots.cleanup();
  }
});

test("CLI: prepare purchase is deterministic in its intent hash", async () => {
  const roots = tempRoots();
  try {
    const a = await run(["prepare", "purchase", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    const b = await run(["prepare", "purchase", "cdp_bazaar:ext-1", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    const ia = (soleJson(a).data as Record<string, unknown>).intent as Record<string, unknown>;
    const ib = (soleJson(b).data as Record<string, unknown>).intent as Record<string, unknown>;
    assert.equal(ia.hash, ib.hash);
    assert.equal(ia.id, ib.id);
  } finally {
    roots.cleanup();
  }
});

test("CLI: prepare publish only accepts the known product", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["prepare", "publish", "some-other-product", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 2);
    const error = soleJson(out).error as Record<string, unknown>;
    assert.equal(error.code, "INVALID_INPUT");
  } finally {
    roots.cleanup();
  }
});

test("CLI: prepare publish data-quality-profiler never publishes", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["prepare", "publish", "data-quality-profiler", "--json"], {
      env: roots.env,
      adapters: ALL,
    });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const readiness = data.readiness as Record<string, unknown>;
    assert.equal(readiness.publicationAllowed, false);
    assert.equal(readiness.publicationExecuted, false);
    const intents = data.intents as Array<Record<string, unknown>>;
    assert.ok(intents.length >= 1);
    for (const intent of intents) {
      assert.equal(intent.kind, "publish");
      assert.equal(intent.registrationPerformed, false);
      assert.equal(intent.publicationPerformed, false);
      const decision = intent.decision as Record<string, unknown>;
      assert.equal(decision.decision, "block");
      assert.equal(decision.reason, "EXTERNAL_WRITE_DISABLED");
    }
    const platforms = intents.map((i) => i.platform);
    assert.deepEqual(platforms, [...platforms].sort());
  } finally {
    roots.cleanup();
  }
});

test("CLI: probe reports per-adapter health and never fails on an outage", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["probe", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const probes = data.probes as Array<Record<string, unknown>>;
    assert.equal(probes.length, 3);
    const byPlatform = new Map(probes.map((p) => [p.platform, p]));
    assert.equal(byPlatform.get("cdp_bazaar")?.status, "ok");
    assert.equal(byPlatform.get("the402")?.status, "unreachable");
    assert.deepEqual(
      probes.map((p) => p.platform),
      [...probes.map((p) => p.platform as string)].sort(),
    );
  } finally {
    roots.cleanup();
  }
});

test("CLI: probe records a disabled adapter as disabled, not unreachable", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["probe", "--json"], {
      env: { ...roots.env, COMMERCE_DISABLE_THE402: "1" },
      adapters: ALL,
    });
    const data = soleJson(out).data as Record<string, unknown>;
    const probes = data.probes as Array<Record<string, unknown>>;
    const the402 = probes.find((p) => p.platform === "the402");
    assert.equal(the402?.status, "disabled");
  } finally {
    roots.cleanup();
  }
});

test("CLI: export writes the canonical repository outputs with checksums", async () => {
  const roots = tempRoots();
  try {
    await run(["discover", "services", "x", "--json"], { env: roots.env, adapters: ALL });
    await run(["discover", "work", "--json"], { env: roots.env, adapters: ALL });
    await run(["probe", "--json"], { env: roots.env, adapters: ALL });

    const out = await run(["export", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const data = soleJson(out).data as Record<string, unknown>;
    const artifacts = data.artifacts as Array<Record<string, unknown>>;
    const paths = artifacts.map((a) => a.path as string);
    for (const expected of [
      "analytics/commerce-control/legacy/services-snapshot.json",
      "analytics/commerce-control/legacy/work-snapshot.json",
      "analytics/commerce-control/legacy/source-health-snapshot.json",
      "analytics/commerce-control/legacy/status-snapshot.json",
    ]) {
      assert.ok(paths.includes(expected), `missing export ${expected}`);
      assert.ok(existsSync(join(roots.env.COMMERCE_REPO_ROOT as string, expected)));
    }
    for (const artifact of artifacts) {
      assert.match(artifact.sha256 as string, /^[0-9a-f]{64}$/);
      assert.ok((artifact.bytes as number) > 0);
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: exported files are valid JSON and contain no secret-like values", async () => {
  const roots = tempRoots();
  try {
    await run(["discover", "services", "x", "--json"], { env: roots.env, adapters: ALL });
    await run(["export", "--json"], { env: roots.env, adapters: ALL });
    const repoRoot = roots.env.COMMERCE_REPO_ROOT as string;
    for (const rel of [
      "analytics/commerce-control/legacy/services-snapshot.json",
      "analytics/commerce-control/legacy/status-snapshot.json",
    ]) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      JSON.parse(text);
      for (const forbidden of [
        "PRIVATE_KEY",
        "mnemonic",
        "nostr+walletconnect",
        "authorization",
        "sk-",
      ]) {
        assert.equal(
          text.toLowerCase().includes(forbidden.toLowerCase()),
          false,
          `export leaked ${forbidden}`,
        );
      }
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: doctor proves Mode A, both gates false, and no wallet secret", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["doctor", "--json"], { env: roots.env, adapters: ALL });
    assert.equal(out.code, 0);
    const doc = soleJson(out);
    const data = doc.data as Record<string, unknown>;
    assert.equal(data.mode, "A");
    assert.equal(data.externalWritesEnabled, false);
    assert.equal(data.liveValueMovementEnabled, false);
    assert.equal(data.walletSecretPresent, false);
    const checks = data.checks as Array<Record<string, unknown>>;
    const byId = new Map(checks.map((c) => [c.id, c]));
    for (const required of [
      "node_version",
      "node_sqlite",
      "mode_a",
      "external_writes_disabled",
      "live_value_movement_disabled",
      "wallet_secret_absent",
      "state_writable",
      "state_migrations",
      "adapters_registered",
    ]) {
      assert.ok(byId.has(required), `doctor must check ${required}`);
      assert.notEqual(byId.get(required)?.status, "fail", `check ${required} failed`);
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: doctor detects a wallet secret in the environment without echoing it", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["doctor", "--json"], {
      env: { ...roots.env, PIPRAIL_PRIVATE_KEY: "0xdeadbeefsupersecret" },
      adapters: ALL,
    });
    assert.equal(out.code, 1);
    const doc = soleJson(out);
    const data = doc.data as Record<string, unknown>;
    assert.equal(data.walletSecretPresent, true);
    assert.equal(out.stdout.includes("0xdeadbeefsupersecret"), false);
    assert.equal(out.stderr.includes("0xdeadbeefsupersecret"), false);
  } finally {
    roots.cleanup();
  }
});

test("CLI: --json puts diagnostics on stderr and only the document on stdout", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["discover", "services", "x", "--json", "--verbose"], {
      env: roots.env,
      adapters: ALL,
    });
    soleJson(out);
    assert.ok(out.stderr.length > 0, "verbose diagnostics must appear on stderr");
    assert.equal(out.stdout.trimEnd().includes("\n{"), false, "only one document allowed");
  } finally {
    roots.cleanup();
  }
});

test("CLI: every command emits schema-stable envelope fields in --json mode", async () => {
  const roots = tempRoots();
  try {
    const commands: readonly string[][] = [
      ["sources"],
      ["status"],
      ["discover", "services", "x"],
      ["discover", "work"],
      ["inspect", "cdp_bazaar:ext-1"],
      ["quote", "cdp_bazaar:ext-1"],
      ["prepare", "purchase", "cdp_bazaar:ext-1"],
      ["prepare", "claim", "agent_bounties:bounty-7"],
      ["prepare", "publish", "data-quality-profiler"],
      ["probe"],
      ["export"],
      ["doctor"],
    ];
    for (const command of commands) {
      const out = await run([...command, "--json"], { env: roots.env, adapters: ALL });
      const doc = soleJson(out);
      assert.equal(typeof doc.ok, "boolean", `${command.join(" ")} missing ok`);
      assert.equal(doc.mode, "A", `${command.join(" ")} missing mode`);
      assert.equal(typeof doc.command, "string");
      assert.equal(typeof doc.version, "string");
      assert.equal(typeof doc.generatedAt, "string");
      assert.equal(doc.financialActionExecuted, false);
      assert.equal(doc.externalMutationExecuted, false);
    }
  } finally {
    roots.cleanup();
  }
});

test("CLI: help and version are available and do not require state", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /commerce sources/);
  assert.match(help.stdout, /prepare publish data-quality-profiler/);

  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("CLI: a refused Mode-B activation attempt fails closed at config load", async () => {
  const roots = tempRoots();
  try {
    const out = await run(["status", "--json"], {
      env: { ...roots.env, LIVE_VALUE_MOVEMENT_ENABLED: "true" },
      adapters: ALL,
    });
    assert.equal(out.code, 1);
    const doc = soleJson(out);
    assert.equal(doc.ok, false);
    const error = doc.error as Record<string, unknown>;
    assert.equal(error.code, "CONFIG_ERROR");
  } finally {
    roots.cleanup();
  }
});
