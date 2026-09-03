import assert from "node:assert/strict";
import test from "node:test";
import { CommerceError } from "../src/core/errors.js";
import {
  extendOpportunityProfile,
  resolveOpportunityProfile,
} from "../src/opportunities/profiles.js";

test("demand is the conservative default profile", () => {
  const profile = resolveOpportunityProfile(undefined);
  assert.equal(profile.id, "demand");
  assert.equal(profile.triage.requireDemand, true);
  assert.notEqual(profile.triage.requireRemote, true);
});

test("automation profile carries reusable positive-fit vocabulary", () => {
  const profile = resolveOpportunityProfile("automation-demand");
  assert.equal(profile.triage.requireDemand, true);
  assert.ok(profile.triage.preferredTerms?.includes("automation"));
  assert.ok(profile.triage.preferredTerms?.includes("api"));
  assert.ok(profile.triage.preferredTerms?.includes("crm"));
});

test("explicit terms extend rather than erase named-profile terms", () => {
  const base = resolveOpportunityProfile("automation-demand").triage;
  const merged = extendOpportunityProfile(base, {
    preferredTerms: ["research", "Automation"],
    excludedTerms: ["survey"],
    requireRemote: true,
    minimumKnownFixedUsd: 25,
  });
  assert.equal(merged.requireDemand, true);
  assert.equal(merged.requireRemote, true);
  assert.equal(merged.minimumKnownFixedUsd, 25);
  assert.ok(merged.preferredTerms?.includes("research"));
  assert.equal(merged.preferredTerms?.filter((term) => term.toLowerCase() === "automation").length, 1);
  assert.deepEqual(merged.excludedTerms, ["survey"]);
});

test("unknown profile fails closed with INVALID_INPUT", () => {
  assert.throws(
    () => resolveOpportunityProfile("does-not-exist"),
    (error: unknown) => error instanceof CommerceError && error.code === "INVALID_INPUT",
  );
});
