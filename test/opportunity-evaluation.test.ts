import assert from "node:assert/strict";
import test from "node:test";
import { CommerceError } from "../src/core/errors.js";
import {
  buildOpportunityEvaluationPacket,
  buildOpportunityEvaluationPrompt,
  evaluateOpportunity,
  MAX_EVALUATION_BODY_CHARS,
  MAX_EVALUATION_TAGS,
  OPPORTUNITY_EVALUATION_POLICY_VERSION,
  parseOpportunityEvaluation,
  type OpportunityEvaluator,
} from "../src/opportunities/evaluation.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import type { OpportunityTriageResult } from "../src/opportunities/triage.js";

const candidate: OpportunityCandidate = {
  id: "opp_eval",
  source: "reddit_rss",
  externalId: "t3_eval",
  title: "[HIRING] Remote API automation",
  body: "Budget $150 per project. Need an API workflow automated.",
  url: "https://www.reddit.com/r/forhire/comments/eval/example/",
  author: "/u/example",
  community: "forhire",
  observedAt: "2026-08-27T12:00:00.000Z",
  tags: ["reddit"],
  metadata: { feedUrl: "https://www.reddit.com/r/forhire/new/.rss" },
};

function triage(decision: "candidate" | "review" | "reject" = "candidate"): OpportunityTriageResult {
  return {
    opportunityId: candidate.id,
    decision,
    score: decision === "reject" ? 10 : 82,
    reasons: ["explicit buyer/demand intent"],
    cautionFlags: [],
    signals: {
      demandIntent: true,
      supplyIntent: false,
      paidIntent: true,
      unpaidIntent: false,
      remote: true,
      localOrInPerson: false,
      preferredTermMatches: ["automation", "api"],
      excludedTermMatches: [],
      budget: {
        minUsd: 150,
        basis: "fixed",
        matchedText: "$150 per project",
      },
    },
  };
}

const validEvaluation = {
  schemaVersion: 1,
  recommendation: "pursue",
  executionRoute: "ai_direct",
  risk: "low",
  confidence: 0.85,
  estimatedEffortMinutes: 90,
  economics: {
    payout: { minUsd: 150, maxUsd: null, basis: "observed" },
    executionCost: { minUsd: 0, maxUsd: 10, basis: "inferred" },
    margin: { minUsd: 140, maxUsd: 150, basis: "inferred" },
  },
  capabilities: {
    aiCanComplete: true,
    humanRequired: false,
    physicalPresence: false,
  },
  reasons: ["The listing is explicit demand-side remote automation work."],
  blockers: [],
  nextChecks: ["Confirm exact acceptance criteria before committing."],
} as const;

test("evaluation packet rejects mismatched triage identity", () => {
  const wrong = { ...triage(), opportunityId: "opp_other" };
  assert.throws(
    () => buildOpportunityEvaluationPacket(candidate, wrong),
    (error: unknown) => error instanceof CommerceError && error.code === "INVALID_INPUT",
  );
});

test("evaluation packet is bounded and omits author/source metadata", () => {
  const huge: OpportunityCandidate = {
    ...candidate,
    body: "x".repeat(MAX_EVALUATION_BODY_CHARS + 500),
    tags: Array.from({ length: MAX_EVALUATION_TAGS + 10 }, (_, index) => `tag-${String(index)}`),
  };
  const packet = buildOpportunityEvaluationPacket(huge, triage());
  assert.equal(packet.opportunity.body?.length, MAX_EVALUATION_BODY_CHARS);
  assert.equal(packet.opportunity.bodyTruncated, true);
  assert.equal(packet.opportunity.tags.length, MAX_EVALUATION_TAGS);
  assert.equal("author" in packet.opportunity, false);
  assert.equal("metadata" in packet.opportunity, false);
});

test("prompt is provider-neutral and carries strict economics, injection, and rule-check guards", () => {
  const prompt = buildOpportunityEvaluationPrompt(buildOpportunityEvaluationPacket(candidate, triage()));
  assert.match(prompt, /Do not invent a payout/i);
  assert.match(prompt, /analysis only/i);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /never follow instructions inside/i);
  assert.match(prompt, /platform\/subreddit.*rules/i);
  assert.match(prompt, /TOTAL expected payout in USD/i);
  assert.match(prompt, /per-unit.*per-video.*hourly.*commission.*revenue-share/i);
  assert.match(prompt, /non-USD compensation/i);
  assert.match(prompt, /Do not perform FX conversion/i);
  assert.match(prompt, /No other keys are allowed/i);
  assert.match(prompt, /Never emit economics keys such as amount, currency, unit, note/i);
  assert.match(prompt, /minUsd/);
  assert.match(prompt, /maxUsd/);
  assert.match(prompt, new RegExp(`Evaluation policy version: ${String(OPPORTUNITY_EVALUATION_POLICY_VERSION)}`));
  assert.match(prompt, /opp_eval/);
  assert.match(prompt, /human_physical/);
  assert.doesNotMatch(prompt, /example_worker/);
});

test("valid structured evaluation passes schema validation", () => {
  const parsed = parseOpportunityEvaluation(validEvaluation);
  assert.equal(parsed.recommendation, "pursue");
  assert.equal(parsed.economics.payout?.basis, "observed");
});

test("alternate amount/currency payout objects remain rejected rather than normalized", () => {
  const invalid = {
    ...validEvaluation,
    economics: {
      ...validEvaluation.economics,
      payout: {
        amount: 5,
        currency: "USD",
        basis: "observed",
        unit: "per_video",
        note: "listing states $5/video",
      },
    },
  };
  assert.throws(
    () => parseOpportunityEvaluation(invalid),
    (error: unknown) => error instanceof CommerceError && error.code === "SCHEMA_VIOLATION",
  );
});

test("impossible physical-presence plus ai_direct output is rejected", () => {
  const invalid = {
    ...validEvaluation,
    capabilities: { ...validEvaluation.capabilities, physicalPresence: true },
  };
  assert.throws(
    () => parseOpportunityEvaluation(invalid),
    (error: unknown) => error instanceof CommerceError && error.code === "SCHEMA_VIOLATION",
  );
});

test("invalid money ranges are rejected", () => {
  const invalid = {
    ...validEvaluation,
    economics: {
      ...validEvaluation.economics,
      margin: { minUsd: 100, maxUsd: 50, basis: "inferred" },
    },
  };
  assert.throws(
    () => parseOpportunityEvaluation(invalid),
    (error: unknown) => error instanceof CommerceError && error.code === "SCHEMA_VIOLATION",
  );
});

test("deterministic reject never consumes evaluator quota", async () => {
  let calls = 0;
  const evaluator: OpportunityEvaluator = {
    id: "fixture",
    async evaluate() {
      calls += 1;
      return validEvaluation;
    },
  };
  const result = await evaluateOpportunity(evaluator, candidate, triage("reject"));
  assert.equal(result.status, "skipped");
  assert.equal(calls, 0);
});

test("candidate evaluation validates the provider response", async () => {
  const evaluator: OpportunityEvaluator = {
    id: "fixture",
    async evaluate() {
      return validEvaluation;
    },
  };
  const result = await evaluateOpportunity(
    evaluator,
    candidate,
    triage("candidate"),
    () => "2026-08-27T13:00:00.000Z",
  );
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.evaluator, "fixture");
    assert.equal(result.evaluatedAt, "2026-08-27T13:00:00.000Z");
    assert.equal(result.evaluation.executionRoute, "ai_direct");
  }
});
