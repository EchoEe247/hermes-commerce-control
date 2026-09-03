import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { AgentBountiesAdapter } from "../src/adapters/agent-bounties/index.js";
import {
  COMPETITION_PAYMENT_PROOF_RULE,
  normalizeUnifiedOpportunity,
  unifiedReadyToEarnUrl,
} from "../src/adapters/agent-bounties/unified.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-30T13:15:00.000Z";

function ctx(fetch: SafeFetch): AdapterContext {
  return {
    fetch,
    evidence: new EvidenceCollector("agent_bounties", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

const ACTIVE_MONTHLY_COMPETITION = {
  opportunity_id: "open-competition-v2:base-mainnet:0x8c990ddf5360c00ee0b2090000e3a3a6f90a6a9d",
  source_type: "canonical_base",
  source_id: "0x8c990ddf5360c00ee0b2090000e3a3a6f90a6a9d",
  source_status: "active",
  title: "Highest externally funded canonical GMV — August 24 to September 21",
  goal: "Create and fund useful marketplace demand that settles canonically during the scoring window. Highest eligible externally funded GMV wins.",
  categories: ["general_digital_work"],
  skills: [],
  public_url: "https://agentbounties.app/competition.html?bountyContract=0x8c990ddf5360c00ee0b2090000e3a3a6f90a6a9d&network=base-mainnet",
  work_state: "claimable",
  payment_state: "escrowed",
  payment_committed: true,
  competition_mode: "best_score",
  network: "base-mainnet",
  verifier_profile_id: "forward-canonical-gmv-attribution-metric-v2",
  verifier_profile_name: "forward-canonical-gmv-attribution-metric-v2",
  standing_meta_bounty: false,
  cash_economics: {
    solver_reward: { amount: "3000000", currency: "USDC", unit: "base_units", decimals: 6 },
    required_external_spend: { amount: "110000", currency: "USDC", unit: "base_units", decimals: 6 },
    gross_cash_margin: { amount: "2890000", currency: "USDC", unit: "base_units", decimals: 6 },
    gross_cash_margin_positive: true,
  },
  reward: { amount: "3000000", currency: "USDC", unit: "base_units", decimals: 6 },
  deadline: "2026-11-21T18:06:29+00:00",
  verification_method: "sp1_plonk",
  verification_ready: true,
  evidence_requirements: {
    participation_phase: "scoring",
    payment_evidence: "CompetitionSettledV2",
    qualifying_action: {
      objective: "Post or fund useful marketplace demand that reaches canonical settlement inside the scoring window.",
    },
    scoring_window: {
      starts_at: "2026-08-24T00:00:00Z",
      ends_at: "2026-09-21T00:00:00Z",
    },
  },
  next_action: {
    action: "generate_open_competition_v2_score",
    method: "GET",
    instructions: "Post and fund useful marketplace demand from the entrant wallet, have a different eligible wallet complete it, and reach canonical child settlement before the scoring window closes. Do not request a proof quote yet.",
  },
};

const UPCOMING_COMPETITION = {
  ...ACTIVE_MONTHLY_COMPETITION,
  opportunity_id: "open-competition-v2:base-mainnet:0xupcoming",
  source_id: "0xupcoming",
  title: "Upcoming competition",
  evidence_requirements: {
    ...ACTIVE_MONTHLY_COMPETITION.evidence_requirements,
    participation_phase: "upcoming",
    scoring_window: {
      starts_at: "2026-09-07T00:00:00Z",
      ends_at: "2026-09-21T00:00:00Z",
    },
  },
  next_action: {
    action: "prepare_open_competition_v2_score",
    method: "GET",
    instructions: "Prepare now; do not fund score before the window starts.",
  },
};

const META_BOUNTY = {
  opportunity_id: "canonical:base-mainnet:0x71b7b3a8ceb534ca904b8513987aa1f3bd6c3d91",
  source_type: "canonical_base",
  source_id: "0x71b7b3a8ceb534ca904b8513987aa1f3bd6c3d91",
  source_status: "claimable",
  title: "Earn 1 USDC profit by creating a paid API reliability child bounty",
  goal: "Create and fully fund a concrete 1 USDC API reliability bounty that a different registered participant completes and receives canonical settlement for, then receive the 2 USDC parent reward.",
  categories: ["engineering", "research"],
  skills: ["API development", "Source verification"],
  public_url: "https://github.com/NSPG13/agent-bounties/issues/647",
  work_state: "claimable",
  payment_state: "escrowed",
  payment_committed: true,
  competition_mode: "exclusive_claim",
  network: "base-mainnet",
  standing_meta_bounty: true,
  reward: { amount: "2000000", currency: "USDC", unit: "base_units", decimals: 6 },
  cash_economics: {
    required_external_spend: { amount: "1000000", currency: "USDC", unit: "base_units", decimals: 6 },
    gross_cash_margin: { amount: "1000000", currency: "USDC", unit: "base_units", decimals: 6 },
  },
  deadline: "2026-10-11T00:00:00+00:00",
  verification_method: "deterministic_module",
  verification_ready: true,
  evidence_requirements: { payment_evidence: "BountySettled" },
  next_action: { action: "inspect", method: "GET", instructions: "Inspect exact terms before claiming." },
};

function projection(items: readonly unknown[]) {
  return {
    schema_version: "agent-bounties/opportunity-projection-v1",
    generated_at: "2026-08-30T11:59:19.673052255+00:00",
    network: "base-mainnet",
    applied_view: "ready_to_earn",
    degraded: false,
    source_statuses: [],
    items,
  };
}

test("unified ready-to-earn URL requests canonical Base opportunities and stays bounded", () => {
  const url = new URL(unifiedReadyToEarnUrl("https://api.agentbounties.app", "base-mainnet", 9999));
  assert.equal(url.pathname, "/v1/opportunities");
  assert.equal(url.searchParams.get("limit"), "300");
  assert.equal(url.searchParams.get("network"), "base-mainnet");
  assert.equal(url.searchParams.get("source_type"), "canonical_base");
  assert.equal(url.searchParams.get("view"), "ready_to_earn");
});

test("active V2 competition is normalized with exact reward, economics and safe actionability", () => {
  const fetch = {} as SafeFetch;
  const context = ctx(fetch);
  const work = normalizeUnifiedOpportunity(
    ACTIVE_MONTHLY_COMPETITION,
    context,
    "https://api.agentbounties.app/v1/opportunities",
    "base-mainnet",
  );
  assert.ok(work !== null);
  assert.equal(work.externalId, ACTIVE_MONTHLY_COMPETITION.opportunity_id);
  assert.equal(work.reward.amount, "3");
  assert.equal(work.reward.usd, "3");
  assert.equal(work.funding.state, "funded");
  assert.equal(work.funding.evidence, "observed");
  assert.equal(work.verification.type, "deterministic");
  assert.equal(work.status, "open");
  assert.equal(work.actionability.canPrepareClaim, true);
  assert.equal(work.actionability.canClaim, false);
  assert.equal(work.actionability.canSubmit, false);
  assert.equal(work.paymentProofRule, COMPETITION_PAYMENT_PROOF_RULE);
  assert.ok(work.requirements.some((x) => x.includes("required external spend: 0.11 USDC")));
  assert.ok(work.requirements.some((x) => x.includes("2.89 USDC")));
  assert.ok(work.requirements.some((x) => x.includes("different eligible wallet")));
  assert.ok(work.requirements.some((x) => x.includes("2026-09-21T00:00:00Z")));
});

test("upcoming competition is visible but cannot be prepared as a live claim/entry", () => {
  const work = normalizeUnifiedOpportunity(
    UPCOMING_COMPETITION,
    ctx({} as SafeFetch),
    "https://api.agentbounties.app/v1/opportunities",
    "base-mainnet",
  );
  assert.ok(work !== null);
  assert.equal(work.status, "open");
  assert.equal(work.actionability.canPrepareClaim, false);
  assert.ok(work.requirements.some((x) => x.includes("participation phase: upcoming")));
});

test("standing meta bounty exposes the independent-participant economics without auto-execution", () => {
  const work = normalizeUnifiedOpportunity(
    META_BOUNTY,
    ctx({} as SafeFetch),
    "https://api.agentbounties.app/v1/opportunities",
    "base-mainnet",
  );
  assert.ok(work !== null);
  assert.equal(work.reward.amount, "2");
  assert.equal(work.actionability.canPrepareClaim, true);
  assert.ok(work.requirements.includes("standing meta bounty"));
  assert.ok(work.requirements.some((x) => x.includes("required external spend: 1 USDC")));
  assert.ok(work.description?.includes("different registered participant"));
});

test("adapter discovers mixed unified market with one bounded GET and preserves limit", async () => {
  const urls: string[] = [];
  const fetch: SafeFetch = {
    async json<T>(url: string): Promise<T> {
      urls.push(url);
      return projection([ACTIVE_MONTHLY_COMPETITION, UPCOMING_COMPETITION, META_BOUNTY]) as T;
    },
    async text(): Promise<never> {
      throw new Error("unexpected text call");
    },
  };
  const adapter = new AgentBountiesAdapter("https://api.agentbounties.app");
  const work = await adapter.discoverWork({ limit: 2 }, ctx(fetch));
  assert.equal(work.length, 2);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0] ?? "");
  assert.equal(url.pathname, "/v1/opportunities");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("view"), "ready_to_earn");
});

test("unified projection drops opportunities whose USDC reward shape is not exact", () => {
  const bad = {
    ...ACTIVE_MONTHLY_COMPETITION,
    reward: { amount: "3.0", currency: "USDC", unit: "base_units", decimals: 6 },
  };
  assert.equal(
    normalizeUnifiedOpportunity(bad, ctx({} as SafeFetch), "https://api.agentbounties.app/v1/opportunities", "base-mainnet"),
    null,
  );
});
