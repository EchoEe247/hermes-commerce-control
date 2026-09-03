/**
 * BountyBook fixtures.
 *
 * Confirmed against the live public API on 2026-08-19 via the endpoint named in
 * the platform's own llms.txt:
 *
 *   GET https://api.bountybook.ai/jobs?status=open&limit=20
 *     -> { jobs, total, page, totalPages }     (total was 115)
 *
 * No authentication is used. llms.txt documents GET /auth/nonce and an Ethereum
 * private key for claiming; this adapter reads jobs only and creates no
 * identity, nonce, signature or token.
 *
 * Field types confirmed live:
 *   budget_usdc         string  "3.00"   (decimal-safe, used verbatim)
 *   chain_id            string  "8453"   (mapped to eip155:8453)
 *   deadline            number  0        (0 means no deadline, not epoch 1970)
 *   spec                object  { instructions, success_condition }
 *   verification_result object  null when unverified
 *   payout_status       string  "none"
 *
 * The platform verifies output with an AI oracle, so verification maps to
 * ai_oracle rather than deterministic.
 */

export const OPEN_JOBS = {
  total: 115,
  page: 1,
  totalPages: 39,
  jobs: [
    {
      id: "60379d18-2a1b-4d47-b732-0f16840680c0",
      chain_id: "8453",
      contract_job_id: 0,
      title: "Write log_parser.py to parse Apache Combined Log Format",
      description: "Write log_parser.py with function parse_log(log_text) -> list[dict].",
      budget_usdc: "3.00",
      job_type: "code",
      bounty_mode: "task",
      difficulty: "standard",
      estimated_minutes: 15,
      status: "open",
      deadline: 0,
      payout_status: "none",
      payout_tx_hash: null,
      verification_result: null,
      claimed_at: null,
      executor_address: null,
      tags: ["python", "parsing", "regex", "logs", "stdlib"],
      spec: {
        instructions: "Implement parse_log(log_text: str) -> list[dict] in log_parser.py.",
        success_condition: "All provided test cases pass.",
      },
      created_at: "2026-08-18T10:00:00.000Z",
      updated_at: "2026-08-18T10:00:00.000Z",
    },
    {
      id: "aa11bb22-cc33-dd44-ee55-ff6677889900",
      chain_id: "8453",
      title: "Summarize a dataset into a markdown report",
      description: "Produce a markdown report summarizing the attached CSV.",
      budget_usdc: "1.50",
      job_type: "data",
      bounty_mode: "task",
      difficulty: "easy",
      estimated_minutes: 10,
      status: "open",
      // A real ISO deadline, to prove both forms are handled.
      deadline: "2026-12-31T00:00:00.000Z",
      payout_status: "none",
      verification_result: null,
      tags: ["data", "markdown"],
      spec: {
        instructions: "Write report.md summarizing the dataset.",
        success_condition: "Report contains row count and column types.",
      },
      created_at: "2026-08-18T11:00:00.000Z",
    },
  ],
};

/** A job already claimed by someone else: not preparable. */
export const CLAIMED_JOB = {
  total: 1,
  page: 1,
  totalPages: 1,
  jobs: [
    {
      ...OPEN_JOBS.jobs[0],
      id: "claimed-job",
      status: "claimed",
      claimed_at: "2026-08-18T12:00:00.000Z",
      executor_address: "0x000000000000000000000000000000000000c0de",
    },
  ],
};

/**
 * A job asserting it was paid, without independent proof.
 * payout_tx_hash is a platform claim, so funding stays observed.
 */
export const PAID_CLAIM_JOB = {
  total: 1,
  page: 1,
  totalPages: 1,
  jobs: [
    {
      ...OPEN_JOBS.jobs[0],
      id: "paid-job",
      status: "completed",
      payout_status: "paid",
      payout_tx_hash: "0xabc123",
      verification_result: { verified: true, score: 1 },
    },
  ],
};

/** Healthy with genuinely nothing open. */
export const EMPTY_JOBS = { total: 0, page: 1, totalPages: 0, jobs: [] };

export const MALFORMED_JOBS = { total: 1, jobs: "not-an-array" };

/** Missing or unusable budget: must be dropped rather than assumed free. */
export const NO_BUDGET_JOBS = {
  total: 1,
  page: 1,
  totalPages: 1,
  jobs: [
    { id: "nobudget", chain_id: "8453", title: "No budget", status: "open", job_type: "code" },
    { id: "badbudget", chain_id: "8453", title: "Bad budget", status: "open", budget_usdc: "1e3" },
  ],
};
