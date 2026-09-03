/**
 * Runtime validation for canonical models.
 *
 * These schemas are the last line of defence between untrusted marketplace
 * payloads and the rest of the system. Two rules matter most:
 *
 *  1. Unknown properties are stripped, so hostile extra fields cannot ride
 *     along into persistence or into an MCP response.
 *  2. Mode-A live-action flags are validated as literal `false`. A bug or a
 *     malicious adapter that tries to emit `canPurchase: true` fails parsing
 *     rather than reaching the intent engine.
 */
import { z } from "zod";
import {
  EVIDENCE_CLASSES,
  FUNDING_STATES,
  PLATFORM_IDS,
  SOURCE_HEALTHS,
  SOURCE_TYPES,
  VERIFIER_TYPES,
  WORK_STATUSES,
  type EvidenceRecord,
  type ServiceCandidate,
  type WorkCandidate,
} from "./models.js";
import { CommerceError } from "./errors.js";
import { isAuthoritativeAmount } from "./money.js";

const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid ISO-8601 timestamp" });

const decimalString = z
  .string()
  .refine(isAuthoritativeAmount, { message: "not a valid authoritative decimal amount" });

const atomicString = z.string().regex(/^\d+$/, "atomic amount must be an unsigned integer string");

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");

export const platformIdSchema = z.enum(PLATFORM_IDS);
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);
export const sourceHealthSchema = z.enum(SOURCE_HEALTHS);
export const verifierTypeSchema = z.enum(VERIFIER_TYPES);
export const fundingStateSchema = z.enum(FUNDING_STATES);
export const workStatusSchema = z.enum(WORK_STATUSES);
export const sourceTypeSchema = z.enum(SOURCE_TYPES);

export const evidenceRecordSchema = z
  .object({
    platform: platformIdSchema,
    fact: z.string().min(1),
    value: z.string(),
    classification: evidenceClassSchema,
    sourceType: sourceTypeSchema,
    sourceRef: z.string().min(1),
    capturedAt: isoDateTime,
    hash: sha256,
    rawPath: z.string().optional(),
  })
  .strip();

export const sourceObservationSchema = z
  .object({
    source: platformIdSchema,
    externalId: z.string().min(1),
    observedAt: isoDateTime,
    sourceUrl: z.string().optional(),
  })
  .strip();

export const assetRefSchema = z
  .object({
    address: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().int().min(0).max(36).optional(),
  })
  .strip();

export const priceRefSchema = z
  .object({
    atomic: atomicString.optional(),
    decimal: decimalString.optional(),
    display: z.string().optional(),
    currency: z.string().optional(),
    usd: decimalString.optional(),
  })
  .strip();

export const activityMetricsSchema = z
  .object({
    calls30d: z.number().int().min(0).optional(),
    uniquePayers30d: z.number().int().min(0).optional(),
    successRate: z.number().min(0).max(1).optional(),
  })
  .strip();

/** Live purchase must be literal false. */
export const serviceActionabilitySchema = z
  .object({
    canQuote: z.boolean(),
    canPreparePurchase: z.boolean(),
    canPurchase: z.literal(false),
  })
  .strip();

/** Live claim and submit must be literal false. */
export const workActionabilitySchema = z
  .object({
    canPrepareClaim: z.boolean(),
    canClaim: z.literal(false),
    canSubmit: z.literal(false),
  })
  .strip();

export const serviceCandidateSchema = z
  .object({
    id: z.string().regex(/^svc_[0-9a-f]{32}$/),
    kind: z.literal("service"),
    sources: z.array(sourceObservationSchema).min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    resourceUrl: z.string().min(1),
    method: z.string().regex(/^[A-Z]+$/),
    protocol: z.string().min(1),
    network: z.string().optional(),
    asset: assetRefSchema.optional(),
    price: priceRefSchema.optional(),
    payTo: z.string().optional(),
    health: sourceHealthSchema,
    observedAt: isoDateTime,
    activity: activityMetricsSchema.optional(),
    tags: z.array(z.string()),
    evidence: z.array(evidenceRecordSchema),
    actionability: serviceActionabilitySchema,
  })
  .strip();

export const rewardRefSchema = z
  .object({
    amount: decimalString,
    asset: z.string().min(1),
    network: z.string().optional(),
    usd: decimalString.optional(),
  })
  .strip();

export const fundingRefSchema = z
  .object({
    state: fundingStateSchema,
    evidence: evidenceClassSchema,
    proofRef: z.string().optional(),
  })
  .strip();

export const verificationRefSchema = z
  .object({
    type: verifierTypeSchema,
    description: z.string().optional(),
  })
  .strip();

export const workCandidateSchema = z
  .object({
    id: z.string().regex(/^wrk_[0-9a-f]{32}$/),
    kind: z.literal("work"),
    source: platformIdSchema,
    externalId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    url: z.string().optional(),
    reward: rewardRefSchema,
    funding: fundingRefSchema,
    verification: verificationRefSchema,
    deadline: isoDateTime.optional(),
    requirements: z.array(z.string()),
    status: workStatusSchema,
    paymentProofRule: z.string().optional(),
    observedAt: isoDateTime,
    evidence: z.array(evidenceRecordSchema),
    actionability: workActionabilitySchema,
  })
  .strip();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") ?? "";
    throw new CommerceError(
      "SCHEMA_VIOLATION",
      `invalid ${what}${where === "" ? "" : ` at "${where}"`}: ${first?.message ?? "unknown"}`,
      { what },
    );
  }
  return result.data;
}

export function parseServiceCandidate(value: unknown): ServiceCandidate {
  return parseOrThrow(serviceCandidateSchema, value, "ServiceCandidate") as ServiceCandidate;
}

export function parseWorkCandidate(value: unknown): WorkCandidate {
  return parseOrThrow(workCandidateSchema, value, "WorkCandidate") as WorkCandidate;
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  return parseOrThrow(evidenceRecordSchema, value, "EvidenceRecord") as EvidenceRecord;
}
