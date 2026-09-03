/**
 * Agent Bounties fixtures.
 *
 * Confirmed against the live public API on 2026-08-19:
 *
 *   GET /v1/base/autonomous-bounties/inventory-summary?network&claimable_only
 *     -> { schema_version, network, generated_at, canonical_source,
 *          claimable_bounty_count, verification_ready_bounty_count,
 *          standing_meta_bounty_count, funded_usdc_base_units, funded_usdc,
 *          solver_reward_usdc_base_units, solver_reward_usdc,
 *          verifier_reward_usdc_base_units, verifier_reward_usdc,
 *          items[], evidence_boundary }
 *
 *   item -> { bounty_id, bounty_contract, title, status,
 *             funded_usdc_base_units, solver_reward_usdc_base_units,
 *             verifier_reward_usdc_base_units, verification_ready,
 *             standing_meta_bounty }
 *
 * This is a non-streaming snapshot, so it is preferred over
 * /v1/opportunities/stream (SSE). /v1/bounties/claimable and /v1/bounties/feed
 * both returned [] at capture time.
 *
 * Amounts are atomic USDC strings ("1000000" == 1.00 at 6 decimals), which is
 * decimal-safe and used verbatim.
 *
 * The platform's llms.txt states the authoritative settlement rule:
 * "Only canonical events establish bounty state. Only `BountySettled` proves
 * bounty payment." Canonical lifecycle events are CanonicalBountyCreated,
 * FundingAdded, BountyBecameClaimable and BountySettled.
 */

export const INVENTORY_SUMMARY = {
  schema_version: "agent-bounties/inventory-summary-v1",
  network: "base-mainnet",
  generated_at: "2026-08-19T06:16:47.819370243+00:00",
  canonical_source:
    "https://api.agentbounties.app/v1/base/autonomous-bounties/feed?network=base-mainnet&claimable_only=true",
  claimable_bounty_count: 2,
  verification_ready_bounty_count: 2,
  standing_meta_bounty_count: 0,
  funded_usdc_base_units: "2200000",
  funded_usdc: "2.20",
  solver_reward_usdc_base_units: "2000000",
  solver_reward_usdc: "2.00",
  verifier_reward_usdc_base_units: "200000",
  verifier_reward_usdc: "0.20",
  evidence_boundary: "canonical on-chain events only",
  items: [
    {
      bounty_id: "0x51408b922225594472fd1a55798209f813554c58714e7ad442177181697eba69",
      bounty_contract: "0x22cec92c195a6dc0f7aeaf850e7f2cacb3b6de33",
      title: "Add one truthful inventory-state breakdown response",
      status: "claimable",
      funded_usdc_base_units: "1100000",
      solver_reward_usdc_base_units: "1000000",
      verifier_reward_usdc_base_units: "100000",
      verification_ready: true,
      standing_meta_bounty: false,
    },
    {
      bounty_id: "0x5dfa3c356d4c13b81ef40facc1086e82e24da437e1d10ad6d10d355d6319b933",
      bounty_contract: "0x2b0856b5ec229cbb0a5bcfaa825e7d6c03cffaaf",
      title: "Add retry-safe Base RPC failover for maintainer workflows",
      status: "claimable",
      funded_usdc_base_units: "1100000",
      solver_reward_usdc_base_units: "1000000",
      verifier_reward_usdc_base_units: "100000",
      verification_ready: true,
      standing_meta_bounty: false,
    },
  ],
};

/** Each distinct lifecycle state, so state mapping is tested explicitly. */
export const LIFECYCLE_ITEMS = [
  {
    bounty_id: "0xadvertised",
    bounty_contract: "0xc1",
    title: "Advertised but not funded",
    status: "open",
    funded_usdc_base_units: "0",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: false,
    standing_meta_bounty: false,
  },
  {
    bounty_id: "0xfunded",
    bounty_contract: "0xc2",
    title: "Funded and claimable",
    status: "claimable",
    funded_usdc_base_units: "1100000",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: true,
    standing_meta_bounty: false,
  },
  {
    bounty_id: "0xclaimed",
    bounty_contract: "0xc3",
    title: "Already claimed",
    status: "claimed",
    funded_usdc_base_units: "1100000",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: true,
    standing_meta_bounty: false,
  },
  {
    bounty_id: "0xsubmitted",
    bounty_contract: "0xc4",
    title: "Work submitted, awaiting verification",
    status: "submitted",
    funded_usdc_base_units: "1100000",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: true,
    standing_meta_bounty: false,
  },
  {
    bounty_id: "0xsettled",
    bounty_contract: "0xc5",
    title: "Settled and paid",
    status: "settled",
    funded_usdc_base_units: "1100000",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: true,
    standing_meta_bounty: false,
  },
  {
    bounty_id: "0xrefunded",
    bounty_contract: "0xc6",
    title: "Refunded to creator",
    status: "refunded",
    funded_usdc_base_units: "0",
    solver_reward_usdc_base_units: "1000000",
    verification_ready: false,
    standing_meta_bounty: false,
  },
];

export const LIFECYCLE_SUMMARY = {
  ...INVENTORY_SUMMARY,
  claimable_bounty_count: 1,
  items: LIFECYCLE_ITEMS,
};

/** Healthy with genuinely nothing to do. */
export const EMPTY_SUMMARY = {
  ...INVENTORY_SUMMARY,
  claimable_bounty_count: 0,
  verification_ready_bounty_count: 0,
  funded_usdc_base_units: "0",
  solver_reward_usdc_base_units: "0",
  items: [],
};

/**
 * A leaderboard-style payload asserting payment without a BountySettled event.
 * Advertised reward and leaderboard rank must never reach payment=verified.
 */
export const LEADERBOARD_CLAIM = {
  ...INVENTORY_SUMMARY,
  items: [
    {
      ...INVENTORY_SUMMARY.items[0],
      status: "settled",
      // No canonical event reference; the platform merely says it paid.
      paid: true,
      leaderboard_rank: 1,
    },
  ],
};

export const MALFORMED_SUMMARY = { schema_version: "x", items: "not-an-array" };
