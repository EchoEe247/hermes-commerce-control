import assert from "node:assert/strict";
import test from "node:test";
import type { OpportunityCandidate } from "../src/opportunities/models.js";
import {
  extractUsdBudget,
  triageOpportunity,
} from "../src/opportunities/triage.js";

function opportunity(title: string, body = ""): OpportunityCandidate {
  return {
    id: "opp_test",
    source: "reddit_rss",
    externalId: "t3_test",
    title,
    body,
    observedAt: "2026-08-27T12:00:00.000Z",
    tags: ["reddit"],
    metadata: {},
  };
}

test("extractUsdBudget ignores bare numbers and parses fixed USD ranges", () => {
  assert.equal(extractUsdBudget("Need this in 2026 with 12 records"), undefined);
  assert.deepEqual(extractUsdBudget("Budget is $75-$125 USD for the project"), {
    minUsd: 75,
    maxUsd: 125,
    basis: "fixed",
    matchedText: "$75-$125 USD",
  });
});

test("extractUsdBudget keeps hourly amounts separate from fixed-price thresholds", () => {
  const hourly = extractUsdBudget("Pay is USD 35 per hour, remote.");
  assert.ok(hourly !== undefined);
  assert.equal(hourly.minUsd, 35);
  assert.equal(hourly.basis, "hourly");

  const triage = triageOpportunity(
    opportunity("[Hiring] Remote automation help", "Pay is USD 35 per hour."),
    { minimumKnownFixedUsd: 100 },
  );
  assert.notEqual(triage.decision, "reject");
});

test("unpaid does not accidentally count as paid and is rejected", () => {
  const result = triageOpportunity(
    opportunity("Unpaid volunteer needed", "Remote documentation project."),
  );
  assert.equal(result.signals.unpaidIntent, true);
  assert.equal(result.signals.paidIntent, false);
  assert.equal(result.decision, "reject");
});

test("remote paid preferred buyer work becomes a candidate without a model call", () => {
  const result = triageOpportunity(
    opportunity(
      "[Hiring] Remote automation workflow",
      "Budget $150 per project. Need API integration and CRM automation.",
    ),
    {
      requireDemand: true,
      requireRemote: true,
      minimumKnownFixedUsd: 50,
      preferredTerms: ["automation", "API integration", "CRM"],
    },
  );
  assert.equal(result.signals.demandIntent, true);
  assert.equal(result.signals.supplyIntent, false);
  assert.equal(result.decision, "candidate");
  assert.ok(result.score >= 65);
  assert.deepEqual(result.signals.preferredTermMatches, ["automation", "api integration", "crm"]);
  assert.equal(result.signals.budget?.minUsd, 150);
  assert.equal(result.signals.budget?.basis, "fixed");
});

test("for-hire seller post is rejected by a demand-only profile even when it matches skills", () => {
  const result = triageOpportunity(
    opportunity(
      "[FOR HIRE] Automation and AI integrations",
      "Available for projects. Remote. $40/hr. I build CRM automation and APIs.",
    ),
    { requireDemand: true, preferredTerms: ["automation", "AI", "CRM"] },
  );
  assert.equal(result.signals.supplyIntent, true);
  assert.equal(result.signals.demandIntent, false);
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.some((reason) => reason.includes("demand-only")));
});

test("compact FORHIRE tag is also recognized as seller supply", () => {
  const result = triageOpportunity(
    opportunity("[FORHIRE] Python automation developer", "Remote. Available for projects."),
    { requireDemand: true },
  );
  assert.equal(result.signals.supplyIntent, true);
  assert.equal(result.signals.demandIntent, false);
  assert.equal(result.decision, "reject");
});

test("task tags are demand while offer tags are supply", () => {
  const task = triageOpportunity(
    opportunity("[TASK] Automate a spreadsheet", "Pay $50 for project."),
    { requireDemand: true },
  );
  const offer = triageOpportunity(
    opportunity("[OFFER] I automate spreadsheets", "My services start at $50."),
    { requireDemand: true },
  );
  assert.equal(task.signals.demandIntent, true);
  assert.equal(task.signals.supplyIntent, false);
  assert.notEqual(task.decision, "reject");
  assert.equal(offer.signals.supplyIntent, true);
  assert.equal(offer.decision, "reject");
});

test("explicit local-only work is rejected by a remote-only profile", () => {
  const result = triageOpportunity(
    opportunity("[Paid] Local only pickup task", "Must be local. $100 for the task."),
    { requireRemote: true },
  );
  assert.equal(result.signals.localOrInPerson, true);
  assert.equal(result.decision, "reject");
});

test("known fixed-price work below the configured floor is rejected", () => {
  const result = triageOpportunity(
    opportunity("[Hiring] Small remote task", "Fixed budget: $20 for project."),
    { minimumKnownFixedUsd: 50 },
  );
  assert.equal(result.signals.budget?.basis, "fixed");
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.some((reason) => reason.includes("below minimum")));
});

test("caution language lowers score without making an unsupported fraud determination", () => {
  const result = triageOpportunity(
    opportunity(
      "[Hiring] Remote assistant",
      "Paid role. Send money for a setup fee first. Contact via Telegram only.",
    ),
  );
  assert.deepEqual(result.cautionFlags, ["upfront-payment-language", "telegram-only-contact"]);
  assert.notEqual(result.decision, "reject");
  assert.ok(result.reasons.some((reason) => reason.startsWith("caution signal")));
});
