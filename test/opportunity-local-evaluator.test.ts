import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildOpportunityEvaluationPacket } from "../src/opportunities/evaluation.js";
import { buildPreparedOpportunityEvaluation } from "../src/opportunities/evaluation-queue.js";
import {
  JsonlOpportunityEvaluationResultStore,
  evaluationResultKey,
} from "../src/opportunities/evaluation-results.js";
import { runPreparedOpportunityEvaluations } from "../src/opportunities/evaluation-runner.js";
import { LocalOpenAiOpportunityEvaluator } from "../src/opportunities/local-openai-evaluator.js";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import { triageOpportunity } from "../src/opportunities/triage.js";

const candidate: OpportunityCandidate = {
  id: "opp_local_eval",
  source: "reddit_rss",
  externalId: "local-eval",
  title: "[HIRING] Remote API automation",
  body: "Budget $150 per project. Need API integration. Remote.",
  observedAt: "2026-08-27T15:00:00.000Z",
  tags: ["reddit", "automation"],
  metadata: {},
};

const triage = triageOpportunity(candidate, { requireDemand: true });
const packet = buildOpportunityEvaluationPacket(candidate, triage);
const prepared = buildPreparedOpportunityEvaluation(packet);

const validEvaluation = {
  schemaVersion: 1,
  recommendation: "pursue",
  executionRoute: "ai_direct",
  risk: "low",
  confidence: 0.9,
  estimatedEffortMinutes: 60,
  economics: {
    payout: { minUsd: 150, maxUsd: null, basis: "observed" },
    executionCost: { minUsd: 0, maxUsd: 10, basis: "inferred" },
    margin: { minUsd: 140, maxUsd: 150, basis: "inferred" },
  },
  capabilities: { aiCanComplete: true, humanRequired: false, physicalPresence: false },
  reasons: ["remote automation work with explicit budget"],
  blockers: [],
  nextChecks: ["verify current subreddit participation rules"],
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("local evaluator rejects remote, DNS-named, and credential-bearing endpoints", () => {
  assert.throws(
    () => new LocalOpenAiOpportunityEvaluator({ baseUrl: "https://example.com/v1", model: "free" }),
    /loopback|local evaluator/i,
  );
  assert.throws(
    () => new LocalOpenAiOpportunityEvaluator({ baseUrl: "http://localhost:20130/v1", model: "free" }),
    /literal loopback/i,
  );
  assert.throws(
    () => new LocalOpenAiOpportunityEvaluator({ baseUrl: "http://user:pass@127.0.0.1:20130/v1", model: "free" }),
    /credentials/i,
  );
});

test("local evaluator sends one unauthenticated OpenAI-compatible chat request and parses strict JSON", async () => {
  let calls = 0;
  const evaluator = new LocalOpenAiOpportunityEvaluator({
    baseUrl: "http://127.0.0.1:20130/v1",
    model: "free-model",
    fetchImpl: (async (input, init) => {
      calls += 1;
      assert.equal(String(input), "http://127.0.0.1:20130/v1/chat/completions");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("cookie"), false);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        stream: boolean;
      };
      assert.equal(body.model, "free-model");
      assert.equal(body.stream, false);
      assert.equal(body.messages.length, 1);
      assert.match(body.messages[0]?.content ?? "", /Return JSON only/);
      return okResponse(JSON.stringify(validEvaluation));
    }) as typeof fetch,
  });

  const raw = await evaluator.evaluate(packet);
  assert.deepEqual(raw, validEvaluation);
  assert.equal(calls, 1);
});

test("local evaluator refuses fenced or otherwise non-strict assistant JSON", async () => {
  const evaluator = new LocalOpenAiOpportunityEvaluator({
    baseUrl: "http://127.0.0.1:20130/v1",
    model: "free-model",
    fetchImpl: (async () => okResponse(`\`\`\`json\n${JSON.stringify(validEvaluation)}\n\`\`\``)) as typeof fetch,
  });
  await assert.rejects(() => evaluator.evaluate(packet), /strict JSON|markdown\/code-fence/i);
});

test("evaluation runner persists a valid result and skips an identical evaluator/request on rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "opportunity-eval-results-"));
  try {
    const store = new JsonlOpportunityEvaluationResultStore(join(root, "evaluations.jsonl"));
    let calls = 0;
    const evaluator = {
      id: "fixture-evaluator",
      async evaluate() {
        calls += 1;
        return validEvaluation;
      },
    };
    const first = await runPreparedOpportunityEvaluations([prepared], evaluator, store, {
      clock: () => "2026-08-27T15:01:00.000Z",
    });
    assert.equal(first[0]?.status, "completed");
    assert.equal(calls, 1);

    const keys = await store.seenKeys();
    assert.equal(keys.has(evaluationResultKey(prepared.requestId, evaluator.id)), true);

    const second = await runPreparedOpportunityEvaluations([prepared], evaluator, store);
    assert.equal(second[0]?.status, "skipped");
    assert.equal(calls, 1, "dedupe must prevent a second model call");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed persisted evaluation does not suppress a future valid evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opportunity-eval-corrupt-"));
  try {
    const path = join(root, "evaluations.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        requestId: prepared.requestId,
        opportunityId: prepared.opportunityId,
        evaluatorId: "fixture-evaluator",
        evaluatedAt: "2026-08-27T15:00:00.000Z",
        evaluation: { invalid: true },
      })}\n`,
      "utf8",
    );
    const store = new JsonlOpportunityEvaluationResultStore(path);
    assert.equal((await store.seenKeys()).size, 0);

    let calls = 0;
    const results = await runPreparedOpportunityEvaluations(
      [prepared],
      { id: "fixture-evaluator", async evaluate() { calls += 1; return validEvaluation; } },
      store,
    );
    assert.equal(results[0]?.status, "completed");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shape-valid but semantically impossible persisted evaluation is ignored on replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "opportunity-eval-semantic-"));
  try {
    const path = join(root, "evaluations.jsonl");
    const impossible = {
      ...validEvaluation,
      executionRoute: "ai_direct",
      capabilities: { aiCanComplete: true, humanRequired: true, physicalPresence: true },
    };
    await writeFile(
      path,
      `${JSON.stringify({
        requestId: prepared.requestId,
        opportunityId: prepared.opportunityId,
        evaluatorId: "fixture-evaluator",
        evaluatedAt: "2026-08-27T15:00:00.000Z",
        evaluation: impossible,
      })}\n`,
      "utf8",
    );
    const store = new JsonlOpportunityEvaluationResultStore(path);
    assert.equal((await store.seenKeys()).size, 0);
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncated evaluation tail is repaired before the next append", async () => {
  const root = await mkdtemp(join(tmpdir(), "opportunity-eval-tail-"));
  try {
    const path = join(root, "evaluations.jsonl");
    await appendFile(path, '{"requestId":"broken"', "utf8");
    const store = new JsonlOpportunityEvaluationResultStore(path);
    const results = await runPreparedOpportunityEvaluations(
      [prepared],
      { id: "tail-evaluator", async evaluate() { return validEvaluation; } },
      store,
      { clock: () => "2026-08-27T15:02:00.000Z" },
    );
    assert.equal(results[0]?.status, "completed");
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(text, /broken/);
    assert.match(text, /tail-evaluator/);
    assert.equal(text.endsWith("\n"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation runner records malformed-provider failure without persisting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opportunity-eval-fail-"));
  try {
    const store = new JsonlOpportunityEvaluationResultStore(join(root, "evaluations.jsonl"));
    const results = await runPreparedOpportunityEvaluations(
      [prepared],
      { id: "bad-evaluator", async evaluate() { return { nope: true }; } },
      store,
    );
    assert.equal(results[0]?.status, "failed");
    assert.equal((await store.seenKeys()).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
