import assert from "node:assert/strict";
import test from "node:test";
import { buildOpportunityVerificationResolution } from "../src/opportunities/verification-resolutions.js";

const base = {
  dossierId: `opdos_${"a".repeat(32)}`,
  checkId: `opcheck_${"b".repeat(32)}`,
  outcome: "satisfied" as const,
  recordedAt: "2026-08-27T16:00:00.000Z",
};

test("source-reference evidence requires a credential-free HTTP(S) URL", () => {
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      ...base,
      evidence: { kind: "source_reference", reference: "not-a-url", note: "invalid source" },
    }),
  );
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      ...base,
      evidence: { kind: "source_reference", reference: "https://user:pass@example.test/source", note: "credentialed source" },
    }),
  );
  const record = buildOpportunityVerificationResolution({
    ...base,
    evidence: { kind: "source_reference", reference: "https://example.test/source", note: "public source" },
  });
  assert.equal(record.evidence.reference, "https://example.test/source");
});

test("opaque executor quote references remain allowed", () => {
  const record = buildOpportunityVerificationResolution({
    ...base,
    evidence: { kind: "executor_quote", reference: "quote:executor-123", note: "quote captured locally" },
  });
  assert.equal(record.evidence.reference, "quote:executor-123");
});

test("calculation dependency IDs are canonicalized for stable derived identity", () => {
  const firstId = `opver_${"1".repeat(32)}`;
  const secondId = `opver_${"2".repeat(32)}`;
  const record = buildOpportunityVerificationResolution({
    ...base,
    evidence: { kind: "calculation", note: "Derived calculation." },
    dependsOnResolutionIds: [secondId, firstId, secondId],
  });
  assert.deepEqual(record.dependsOnResolutionIds, [firstId, secondId]);
});

test("dependency bindings are rejected on non-calculation evidence", () => {
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      ...base,
      evidence: { kind: "operator_attestation", note: "Not a derived calculation." },
      dependsOnResolutionIds: [`opver_${"3".repeat(32)}`],
    }),
  );
});

test("verification timestamps require canonical UTC millisecond precision", () => {
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      ...base,
      recordedAt: "2026-08-27T16:00:00.0001Z",
      evidence: { kind: "calculation", note: "Sub-millisecond precision is unsupported." },
    }),
  );
  assert.throws(() =>
    buildOpportunityVerificationResolution({
      ...base,
      recordedAt: "2026-08-27T11:00:00.000-05:00",
      evidence: { kind: "calculation", note: "Offset timestamps are not canonical ledger timestamps." },
    }),
  );
  const record = buildOpportunityVerificationResolution({
    ...base,
    recordedAt: "2026-08-27T16:00:00.001Z",
    evidence: { kind: "calculation", note: "Canonical millisecond timestamp." },
  });
  assert.equal(record.recordedAt, "2026-08-27T16:00:00.001Z");
});
