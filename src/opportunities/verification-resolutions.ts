import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalHash, canonicalJson } from "../core/ids.js";
import { withFileLock } from "./file-lock.js";

export const VERIFICATION_RESOLUTION_OUTCOMES = ["satisfied", "failed"] as const;
export type VerificationResolutionOutcome = (typeof VERIFICATION_RESOLUTION_OUTCOMES)[number];

export const VERIFICATION_EVIDENCE_KINDS = [
  "operator_attestation",
  "source_reference",
  "calculation",
  "executor_quote",
  "counterparty_confirmation",
] as const;
export type VerificationEvidenceKind = (typeof VERIFICATION_EVIDENCE_KINDS)[number];

const resolutionIdSchema = z.string().regex(/^opver_[a-f0-9]{32}$/);
const dependencyResolutionIdsSchema = z
  .array(resolutionIdSchema)
  .max(16)
  .refine((values) => new Set(values).size === values.length, "dependsOnResolutionIds must be unique");
const canonicalRecordedAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "recordedAt must use canonical UTC millisecond format YYYY-MM-DDTHH:mm:ss.sssZ",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "recordedAt must be a valid timestamp");

const evidenceSchema = z
  .object({
    kind: z.enum(VERIFICATION_EVIDENCE_KINDS),
    reference: z.string().trim().min(1).max(2_000).optional(),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

const persistedResolutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    resolutionId: resolutionIdSchema,
    dossierId: z.string().regex(/^opdos_[a-f0-9]{32}$/),
    checkId: z.string().regex(/^opcheck_[a-f0-9]{32}$/),
    outcome: z.enum(VERIFICATION_RESOLUTION_OUTCOMES),
    evidence: evidenceSchema,
    dependsOnResolutionIds: dependencyResolutionIdsSchema.optional(),
    recordedAt: canonicalRecordedAtSchema,
  })
  .strict();

export interface OpportunityVerificationResolution {
  readonly schemaVersion: 1;
  readonly resolutionId: string;
  readonly dossierId: string;
  readonly checkId: string;
  readonly outcome: VerificationResolutionOutcome;
  readonly evidence: {
    readonly kind: VerificationEvidenceKind;
    readonly reference?: string | undefined;
    readonly note: string;
  };
  /** Exact prerequisite resolution IDs used by a derived calculation. */
  readonly dependsOnResolutionIds?: readonly string[] | undefined;
  readonly recordedAt: string;
}

export interface OpportunityVerificationResolutionStore {
  append(record: OpportunityVerificationResolution): Promise<void>;
  /** Omit limit to read every valid persisted resolution. */
  list(limit?: number): Promise<readonly OpportunityVerificationResolution[]>;
}

function evidenceRequiresReference(kind: VerificationEvidenceKind): boolean {
  return kind === "source_reference" || kind === "executor_quote" || kind === "counterparty_confirmation";
}

function assertPublicSourceReference(reference: string): void {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new Error("source_reference evidence requires a valid HTTP(S) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new Error("source_reference evidence requires a credential-free HTTP(S) URL");
  }
}

function assertEvidenceSemantics(record: {
  readonly evidence: OpportunityVerificationResolution["evidence"];
  readonly dependsOnResolutionIds?: readonly string[] | undefined;
}): void {
  const { evidence, dependsOnResolutionIds } = record;
  if (evidenceRequiresReference(evidence.kind) && (evidence.reference === undefined || evidence.reference.trim() === "")) {
    throw new Error(`${evidence.kind} evidence requires a non-empty reference`);
  }
  if (evidence.kind === "source_reference" && evidence.reference !== undefined) {
    assertPublicSourceReference(evidence.reference.trim());
  }
  if ((dependsOnResolutionIds?.length ?? 0) > 0 && evidence.kind !== "calculation") {
    throw new Error("dependsOnResolutionIds are only valid for calculation evidence");
  }
}

function normalizeDependencyResolutionIds(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  if (values.length > 16) throw new Error("dependsOnResolutionIds may contain at most 16 entries");
  const normalized = [...new Set(values.map((value) => resolutionIdSchema.parse(value.trim())))].sort();
  return normalized.length === 0 ? undefined : Object.freeze(normalized);
}

export function buildOpportunityVerificationResolution(input: {
  readonly dossierId: string;
  readonly checkId: string;
  readonly outcome: VerificationResolutionOutcome;
  readonly evidence: OpportunityVerificationResolution["evidence"];
  readonly dependsOnResolutionIds?: readonly string[] | undefined;
  readonly recordedAt?: string | undefined;
}): OpportunityVerificationResolution {
  const dependsOnResolutionIds = normalizeDependencyResolutionIds(input.dependsOnResolutionIds);
  assertEvidenceSemantics({ evidence: input.evidence, dependsOnResolutionIds });
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const base = persistedResolutionSchema
    .omit({ resolutionId: true })
    .parse({
      schemaVersion: 1,
      dossierId: input.dossierId,
      checkId: input.checkId,
      outcome: input.outcome,
      evidence: input.evidence,
      ...(dependsOnResolutionIds === undefined ? {} : { dependsOnResolutionIds }),
      recordedAt,
    });
  const resolutionId = `opver_${canonicalHash(base).slice(0, 32)}`;
  return Object.freeze(persistedResolutionSchema.parse({ ...base, resolutionId }));
}

function recordedAtMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareRows(a: OpportunityVerificationResolution, b: OpportunityVerificationResolution): number {
  const byTime = recordedAtMillis(b.recordedAt) - recordedAtMillis(a.recordedAt);
  if (byTime !== 0) return byTime;
  return a.resolutionId.localeCompare(b.resolutionId);
}

function parsePersistedResolution(value: unknown): OpportunityVerificationResolution | undefined {
  const parsed = persistedResolutionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    assertEvidenceSemantics(parsed.data);
    return Object.freeze(parsed.data);
  } catch {
    return undefined;
  }
}

export class JsonlOpportunityVerificationResolutionStore implements OpportunityVerificationResolutionStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async append(record: OpportunityVerificationResolution): Promise<void> {
    const parsed = persistedResolutionSchema.parse(record);
    assertEvidenceSemantics(parsed);
    await mkdir(dirname(this.#path), { recursive: true });

    await withFileLock(this.#path, async () => {
      await this.#repairTailBeforeAppend();
      const rows = await this.#readAll();
      if (rows.some((row) => row.resolutionId === parsed.resolutionId)) return;
      await appendFile(this.#path, `${canonicalJson(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  async list(limit?: number): Promise<readonly OpportunityVerificationResolution[]> {
    const rows = (await this.#readAll()).sort(compareRows);
    if (limit === undefined) return Object.freeze(rows);
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return Object.freeze(rows.slice(0, bounded));
  }

  async #repairTailBeforeAppend(): Promise<void> {
    let body: Buffer;
    try {
      body = await readFile(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (body.length === 0 || body[body.length - 1] === 0x0a) return;

    const lastNewline = body.lastIndexOf(0x0a);
    const tailStart = lastNewline + 1;
    const tail = body.subarray(tailStart).toString("utf8").trim();
    if (tail !== "") {
      try {
        const raw = JSON.parse(tail) as unknown;
        if (parsePersistedResolution(raw) !== undefined) {
          await appendFile(this.#path, "\n", { encoding: "utf8" });
          return;
        }
      } catch {
        // Fall through and remove the incomplete/invalid final record.
      }
    }
    await truncate(this.#path, tailStart);
  }

  async #readAll(): Promise<OpportunityVerificationResolution[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: OpportunityVerificationResolution[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }
      const parsed = parsePersistedResolution(raw);
      if (parsed !== undefined) rows.push(parsed);
    }
    return rows;
  }
}
