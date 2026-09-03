import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  AgentBountiesAdapter,
  mapFundingState,
  mapStatus,
  mapVerifier,
  normalizeBounty,
  PAYMENT_PROOF_RULE,
} from "../src/adapters/agent-bounties/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  EMPTY_SUMMARY,
  INVENTORY_SUMMARY,
  LEADERBOARD_CLAIM,
  LIFECYCLE_SUMMARY,
  MALFORMED_SUMMARY,
} from "./fixtures/agent-bounties/responses.js";

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
    evidence: new EvidenceCollector("agent_bounties", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

test("agent-bounties: legacy inventory items remain exactly normalizable", () => {
  const work = normalizeBounty(
    INVENTORY_SUMMARY.items[0],
    ctx({} as SafeFetch),
    "https://api.agentbounties.app/v1/base/autonomous-bounties/inventory-summary",
    "base-mainnet",
  );
  assert.ok(work !== null);
  assert.equal(work.reward.amount, "1");
  assert.equal(work.reward.asset, "USDC");
  assert.equal(work.reward.usd, "1");
  assert.equal(work.status, "open");
  assert.equal(work.funding.state, "funded");
  assert.equal(work.verification.type, "deterministic");
  assert.equal(work.actionability.canPrepareClaim, true);
  assert.equal(work.actionability.canClaim, false);
  assert.equal(work.actionability.canSubmit, false);
});

test("agent-bounties: discovery uses bounded unified ready-to-earn projection, never SSE", async () => {
  const stub = stubFetch(() => INVENTORY_SUMMARY);
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  await adapter.discoverWork({}, ctx(stub.fetch));
  assert.equal(stub.urls.length, 1);
  const url = new URL(stub.urls[0] ?? "");
  assert.equal(url.pathname, "/v1/opportunities");
  assert.equal(url.searchParams.get("source_type"), "canonical_base");
  assert.equal(url.searchParams.get("view"), "ready_to_earn");
  assert.equal(url.searchParams.get("limit"), "300");
  assert.equal(url.toString().includes("/stream"), false);
});

test("agent-bounties: legacy lifecycle mapper remains distinct and evidence-conservative", () => {
  const context = ctx({} as SafeFetch);
  const byId = new Map(
    LIFECYCLE_SUMMARY.items
      .map((item) => normalizeBounty(item, context, "https://example.test/inventory", "base-mainnet"))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) => [item.externalId, item]),
  );
  assert.equal(byId.get("0xadvertised")?.funding.state, "advertised");
  assert.equal(byId.get("0xfunded")?.funding.state, "funded");
  assert.equal(byId.get("0xclaimed")?.funding.state, "claimed");
  assert.equal(byId.get("0xsubmitted")?.funding.state, "submitted");
  assert.equal(byId.get("0xsettled")?.funding.state, "settled");
  assert.equal(byId.get("0xrefunded")?.funding.state, "refunded");
  assert.equal(byId.get("0xfunded")?.actionability.canPrepareClaim, true);
  assert.equal(byId.get("0xadvertised")?.actionability.canPrepareClaim, false);
  for (const item of byId.values()) assert.equal(item.funding.evidence, "observed");
});

test("agent-bounties: a leaderboard/paid flag cannot self-certify payment", async () => {
  const stub = stubFetch(() => LEADERBOARD_CLAIM);
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  const work = await adapter.discoverWork({}, ctx(stub.fetch));
  assert.equal(work.length, 1);
  assert.equal(work[0]?.funding.state, "settled");
  assert.equal(work[0]?.funding.evidence, "observed");
});

test("agent-bounties: zero ready-to-earn work is healthy", async () => {
  const stub = stubFetch(() => EMPTY_SUMMARY);
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  assert.deepEqual(await adapter.discoverWork({}, ctx(stub.fetch)), []);
  const probe = await adapter.health(ctx(stub.fetch));
  assert.equal(probe.status, "ok");
  assert.match(String(probe.detail), /0 opportunity/);
});

test("agent-bounties: verifier classification remains strict", () => {
  assert.equal(mapVerifier(true).type, "deterministic");
  assert.equal(mapVerifier(false).type, "unknown");
  assert.equal(mapVerifier(undefined).type, "unknown");
  assert.equal(mapVerifier("true").type, "unknown");
});

test("agent-bounties: status and funding mappers are total", () => {
  assert.equal(mapStatus("claimable"), "open");
  assert.equal(mapStatus("SETTLED"), "closed");
  assert.equal(mapStatus("nonsense"), "unknown");
  assert.equal(mapFundingState("open", "0"), "advertised");
  assert.equal(mapFundingState("open", "1100000"), "funded");
  assert.equal(mapFundingState("refunded", "0"), "refunded");
  assert.equal(mapFundingState("weird", undefined), "unknown");
});

test("agent-bounties: legacy bounty with no usable reward is dropped, not guessed", () => {
  const work = normalizeBounty(
    { bounty_id: "0xnoreward", title: "No reward", status: "claimable" },
    ctx({} as SafeFetch),
    "https://example.test/inventory",
    "base-mainnet",
  );
  assert.equal(work, null);
});

test("agent-bounties: malformed discovery payload raises UPSTREAM_MALFORMED", async () => {
  const stub = stubFetch(() => MALFORMED_SUMMARY);
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  await assert.rejects(() => adapter.discoverWork({}, ctx(stub.fetch)), /UPSTREAM_MALFORMED/);
});

test("agent-bounties: timeout, 429 and 5xx remain isolated typed failures", async () => {
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE"] as const) {
    const stub = stubFetch(() => new CommerceError(code, "boom"));
    await assert.rejects(() => adapter.discoverWork({}, ctx(stub.fetch)), new RegExp(code));
    const probe = await adapter.health(ctx(stub.fetch));
    assert.equal(probe.status, "unreachable");
  }
});

test("agent-bounties: prepareClaim broadcasts nothing and states the block", async () => {
  const stub = stubFetch(() => INVENTORY_SUMMARY);
  const adapter = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl);
  const draft = await adapter.prepareClaim(
    "0x51408b922225594472fd1a55798209f813554c58714e7ad442177181697eba69",
    ctx(stub.fetch),
  );
  assert.equal(draft.claimBroadcast, false);
  assert.equal(draft.submissionBroadcast, false);
  assert.equal(draft.signerPresent, false);
  assert.equal(draft.blockedReason, "EXTERNAL_WRITE_DISABLED");
  assert.ok(Array.isArray(draft.externalStepsRequired));
  assert.match(String(draft.paymentProofRule), /BountySettled/);
  for (const raw of stub.urls) {
    const url = new URL(raw);
    assert.equal(url.pathname, "/v1/opportunities");
  }
});

test("agent-bounties: adapter source contains no mutating request method or endpoint", () => {
  const source = readFileSync(new URL("../src/adapters/agent-bounties/index.ts", import.meta.url), "utf8");
  const unified = readFileSync(new URL("../src/adapters/agent-bounties/unified.ts", import.meta.url), "utf8");
  const joined = `${source}\n${unified}`;
  assert.equal(joined.includes('method: "POST"'), false);
  for (const forbidden of [
    "/claims",
    "/claim-plan",
    "/submission-plan",
    "/submission-evidence",
    "/creation-plan",
    "/timeout-relay",
    "/module-settlement-plan",
  ]) {
    assert.equal(joined.includes(`"${forbidden}`) || joined.includes(`'${forbidden}`), false, `source must not target ${forbidden}`);
  }
});

test("agent-bounties: payment proof rule remains explicit", () => {
  assert.match(PAYMENT_PROOF_RULE, /BountySettled/);
  assert.ok(PAYMENT_PROOF_RULE.length > 40);
});

test("agent-bounties: capabilities never advertise live execution or claiming", () => {
  const caps = new AgentBountiesAdapter(cfg.adapters.agent_bounties.baseUrl).capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.discoverWork, true);
  assert.equal(caps.prepareClaim, true);
  assert.equal(caps.walletless, true);
});
