import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  BountyBookAdapter,
  mapChain,
  mapFundingState,
  mapStatus,
  normalizeBudget,
  normalizeDeadline,
} from "../src/adapters/bountybook/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  CLAIMED_JOB,
  EMPTY_JOBS,
  MALFORMED_JOBS,
  NO_BUDGET_JOBS,
  OPEN_JOBS,
  PAID_CLAIM_JOB,
} from "./fixtures/bountybook/responses.js";

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
    evidence: new EvidenceCollector("bountybook", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

test("bountybook: normalizes an open job with budget, deadline and spec", async () => {
  const stub = stubFetch(() => OPEN_JOBS);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));

  assert.equal(work.length, 2);
  const first = work[0];
  assert.equal(first?.source, "bountybook");
  assert.equal(first?.reward.amount, "3", '"3.00" normalizes to "3"');
  assert.equal(first?.reward.asset, "USDC");
  assert.equal(first?.reward.usd, "3");
  assert.equal(first?.reward.network, "eip155:8453");
  assert.equal(first?.status, "open");
  assert.equal(first?.funding.state, "funded");
  assert.equal(first?.verification.type, "ai_oracle");
  assert.equal(first?.actionability.canClaim, false);
  assert.equal(first?.actionability.canSubmit, false);
  assert.equal(first?.actionability.canPrepareClaim, true);
  // The spec's instructions and success condition become requirements.
  assert.ok((first?.requirements ?? []).some((r) => r.includes("parse_log")));
  assert.ok((first?.requirements ?? []).some((r) => r.startsWith("success condition:")));
});

test("bountybook: deadline 0 means no deadline, not epoch 1970", async () => {
  const stub = stubFetch(() => OPEN_JOBS);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  assert.equal(work[0]?.deadline, undefined, "0 must not become 1970-01-01");
  // The second fixture carries a real ISO deadline.
  assert.equal(work[1]?.deadline, "2026-12-31T00:00:00.000Z");
});

test("bountybook: normalizeDeadline handles seconds, millis, ISO and junk", () => {
  assert.equal(normalizeDeadline(0), undefined);
  assert.equal(normalizeDeadline(-5), undefined);
  assert.equal(normalizeDeadline(null), undefined);
  assert.equal(normalizeDeadline("not a date"), undefined);
  assert.equal(normalizeDeadline(1800000000), "2027-01-15T08:00:00.000Z");
  assert.equal(normalizeDeadline(1800000000000), "2027-01-15T08:00:00.000Z");
  assert.equal(normalizeDeadline("2026-12-31T00:00:00.000Z"), "2026-12-31T00:00:00.000Z");
});

test("bountybook: budget parsing rejects exponent forms rather than coercing", () => {
  assert.equal(normalizeBudget("3.00"), "3");
  assert.equal(normalizeBudget("1.50"), "1.5");
  assert.equal(normalizeBudget(2), "2");
  assert.equal(normalizeBudget(0.5), "0.5");
  assert.equal(normalizeBudget("1e3"), undefined);
  assert.equal(normalizeBudget("-1"), undefined);
  assert.equal(normalizeBudget(Number.NaN), undefined);
  assert.equal(normalizeBudget(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeBudget(undefined), undefined);
  assert.equal(normalizeBudget("free"), undefined);
});

test("bountybook: a job with no usable budget is dropped, not treated as free", async () => {
  const stub = stubFetch(() => NO_BUDGET_JOBS);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  assert.deepEqual(work, [], "both the missing and the 1e3 budget must be dropped");
});

test("bountybook: zero open jobs is source ok with count 0", async () => {
  const stub = stubFetch(() => EMPTY_JOBS);
  const adapter = new BountyBookAdapter();
  assert.deepEqual(await adapter.discoverWork({}, ctx(stub.fetch)), []);
  const probe = await adapter.health(ctx(stub.fetch));
  assert.equal(probe.status, "ok", "empty board is healthy, not a failure");
  assert.match(String(probe.detail), /0 open job/);
});

test("bountybook: a claimed job is not claim-preparable", async () => {
  const stub = stubFetch(() => CLAIMED_JOB);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  assert.equal(work[0]?.status, "claimed");
  assert.equal(work[0]?.funding.state, "claimed");
  assert.equal(work[0]?.actionability.canPrepareClaim, false);
});

test("bountybook: a payout claim cannot self-certify as verified funding", async () => {
  const stub = stubFetch(() => PAID_CLAIM_JOB);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  assert.equal(work[0]?.funding.state, "settled");
  assert.equal(
    work[0]?.funding.evidence,
    "observed",
    "payout_tx_hash plus verification_result is still only the platform's claim",
  );
});

test("bountybook: AI-oracle verification is recorded as inferred", async () => {
  const stub = stubFetch(() => OPEN_JOBS);
  const work = await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  const verifier = work[0]?.evidence.find((e) => e.fact === "verifier_type");
  assert.equal(verifier?.classification, "inferred");
  assert.equal(verifier?.value, "ai_oracle");
});

test("bountybook: mappers are total and chain ids map to CAIP-2", () => {
  assert.equal(mapChain("8453"), "eip155:8453");
  assert.equal(mapChain(8453), "eip155:8453");
  assert.equal(mapChain(""), undefined);
  assert.equal(mapChain("solana"), "solana");
  assert.equal(mapStatus("open"), "open");
  assert.equal(mapStatus("COMPLETED"), "closed");
  assert.equal(mapStatus("weird"), "unknown");
  assert.equal(mapFundingState("open", "none"), "funded");
  assert.equal(mapFundingState("completed", "paid"), "settled");
  assert.equal(mapFundingState("refunded", "none"), "refunded");
  assert.equal(mapFundingState("???", "???"), "unknown");
});

test("bountybook: the request is unauthenticated and only hits /jobs", async () => {
  const stub = stubFetch(() => OPEN_JOBS);
  await new BountyBookAdapter().discoverWork({}, ctx(stub.fetch));
  assert.equal(stub.urls.length, 1);
  const url = stub.urls[0] ?? "";
  assert.match(url, /\/jobs\?/);
  assert.match(url, /status=open/);
  assert.equal(url.includes("/auth/"), false, "must not touch the auth endpoint");
});

test("bountybook: malformed, 429, 5xx and timeout are typed", async () => {
  const adapter = new BountyBookAdapter();
  const bad = stubFetch(() => MALFORMED_JOBS);
  await assert.rejects(() => adapter.discoverWork({}, ctx(bad.fetch)), /UPSTREAM_MALFORMED/);
  for (const code of ["UPSTREAM_TIMEOUT", "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE"] as const) {
    const stub = stubFetch(() => new CommerceError(code, "boom"));
    await assert.rejects(() => adapter.discoverWork({}, ctx(stub.fetch)), new RegExp(code));
    assert.equal((await adapter.health(ctx(stub.fetch))).status, "unreachable");
  }
});

test("bountybook: prepareClaim creates no identity and broadcasts nothing", async () => {
  const stub = stubFetch(() => OPEN_JOBS);
  const draft = await new BountyBookAdapter().prepareClaim(
    "60379d18-2a1b-4d47-b732-0f16840680c0",
    ctx(stub.fetch),
  );
  assert.equal(draft.claimBroadcast, false);
  assert.equal(draft.submissionBroadcast, false);
  assert.equal(draft.ethereumIdentityCreated, false);
  assert.equal(draft.signerPresent, false);
  assert.equal(draft.blockedReason, "EXTERNAL_WRITE_DISABLED");
  for (const url of stub.urls) {
    assert.match(url, /\/jobs\?/, `unexpected request to ${url}`);
  }
});

test("bountybook: the adapter never posts, claims, submits or authenticates", () => {
  const source = readFileSync(
    new URL("../src/adapters/bountybook/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes('method: "POST"'), false);
  for (const forbidden of ["/auth/nonce", "/claim\"", "/submit\"", "executorAddress:"]) {
    assert.equal(source.includes(forbidden), false, `source must not use ${forbidden}`);
  }
});

test("bountybook: capabilities declare read-only walletless scanning", () => {
  const caps = new BountyBookAdapter().capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.discoverWork, true);
  assert.equal(caps.prepareClaim, true);
  assert.equal(caps.walletless, true);
  assert.equal(caps.discoverServices, false);
});
