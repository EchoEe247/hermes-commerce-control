import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, truncate, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalHash, canonicalJson } from "../core/ids.js";
import {
  opportunityEvaluationSchema,
  parseOpportunityEvaluation,
  type OpportunityEvaluation,
} from "./evaluation.js";
import { withFileLock } from "./file-lock.js";

const persistedEvaluationSchema = z
  .object({
    requestId: z.string().min(1),
    opportunityId: z.string().min(1),
    evaluatorId: z.string().min(1),
    evaluatedAt: z
      .string()
      .min(1)
      .refine((value) => Number.isFinite(Date.parse(value)), "evaluatedAt must be a valid timestamp"),
    evaluation: opportunityEvaluationSchema,
  })
  .strict();

export interface PersistedOpportunityEvaluation {
  readonly requestId: string;
  readonly opportunityId: string;
  readonly evaluatorId: string;
  readonly evaluatedAt: string;
  readonly evaluation: OpportunityEvaluation;
}

export interface OpportunityEvaluationClaim {
  readonly key: string;
  readonly token: string;
}

export type OpportunityEvaluationClaimAttempt =
  | { readonly status: "acquired"; readonly claim: OpportunityEvaluationClaim }
  | { readonly status: "already_evaluated" }
  | { readonly status: "claimed_elsewhere" };

export interface OpportunityEvaluationResultStore {
  seenKeys(): Promise<ReadonlySet<string>>;
  claim?(
    requestId: string,
    evaluatorId: string,
  ): Promise<OpportunityEvaluationClaimAttempt>;
  releaseClaim?(claim: OpportunityEvaluationClaim): Promise<void>;
  append(record: PersistedOpportunityEvaluation): Promise<void>;
  /** Omit limit to read every valid persisted result. */
  list(limit?: number): Promise<readonly PersistedOpportunityEvaluation[]>;
}

export interface JsonlOpportunityEvaluationResultStoreOptions {
  readonly claimLeaseMs?: number | undefined;
}

const DEFAULT_CLAIM_LEASE_MS = 30 * 60 * 1_000;

export function evaluationResultKey(requestId: string, evaluatorId: string): string {
  return `${requestId}\u0000${evaluatorId}`;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.trunc(value));
}

function evaluatedAtMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareEvaluationRows(
  a: PersistedOpportunityEvaluation,
  b: PersistedOpportunityEvaluation,
): number {
  const time = evaluatedAtMillis(b.evaluatedAt) - evaluatedAtMillis(a.evaluatedAt);
  if (time !== 0) return time;
  const byEvaluator = a.evaluatorId.localeCompare(b.evaluatorId);
  if (byEvaluator !== 0) return byEvaluator;
  return a.requestId.localeCompare(b.requestId);
}

function parsePersistedRecord(value: unknown): PersistedOpportunityEvaluation | undefined {
  const parsed = persistedEvaluationSchema.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    const evaluation = parseOpportunityEvaluation(parsed.data.evaluation);
    return Object.freeze({ ...parsed.data, evaluation });
  } catch {
    // Shape-valid but semantically impossible evaluations are ignored on replay.
    return undefined;
  }
}

export class JsonlOpportunityEvaluationResultStore implements OpportunityEvaluationResultStore {
  readonly #path: string;
  readonly #claimLeaseMs: number;

  constructor(path: string, options: JsonlOpportunityEvaluationResultStoreOptions = {}) {
    this.#path = path;
    this.#claimLeaseMs = boundedPositive(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
  }

  async seenKeys(): Promise<ReadonlySet<string>> {
    const rows = await this.#readAll();
    return new Set(rows.map((row) => evaluationResultKey(row.requestId, row.evaluatorId)));
  }

  async claim(requestId: string, evaluatorId: string): Promise<OpportunityEvaluationClaimAttempt> {
    const key = evaluationResultKey(requestId, evaluatorId);
    await mkdir(dirname(this.#path), { recursive: true });

    return withFileLock(this.#path, async () => {
      await this.#repairTailBeforeAppend();
      const rows = await this.#readAll();
      if (rows.some((row) => evaluationResultKey(row.requestId, row.evaluatorId) === key)) {
        return Object.freeze({ status: "already_evaluated" as const });
      }

      const claimsDir = `${this.#path}.claims`;
      await mkdir(claimsDir, { recursive: true, mode: 0o700 });
      const claimPath = this.#claimPath(key);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
        try {
          const handle = await open(claimPath, "wx", 0o600);
          try {
            await handle.writeFile(
              `${canonicalJson({ key, token, claimedAt: new Date().toISOString() })}\n`,
              "utf8",
            );
          } finally {
            await handle.close();
          }
          return Object.freeze({
            status: "acquired" as const,
            claim: Object.freeze({ key, token }),
          });
        } catch (error) {
          if (errno(error) !== "EEXIST") throw error;
          try {
            const info = await stat(claimPath);
            if (Date.now() - info.mtimeMs > this.#claimLeaseMs) {
              await unlink(claimPath);
              continue;
            }
          } catch (statError) {
            if (errno(statError) === "ENOENT") continue;
            throw statError;
          }
          return Object.freeze({ status: "claimed_elsewhere" as const });
        }
      }

      return Object.freeze({ status: "claimed_elsewhere" as const });
    });
  }

  async releaseClaim(claim: OpportunityEvaluationClaim): Promise<void> {
    await withFileLock(this.#path, async () => {
      const claimPath = this.#claimPath(claim.key);
      try {
        const parsed = JSON.parse(await readFile(claimPath, "utf8")) as { token?: unknown };
        if (parsed.token === claim.token) await unlink(claimPath);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    });
  }

  async append(record: PersistedOpportunityEvaluation): Promise<void> {
    const shape = persistedEvaluationSchema.parse(record);
    const parsed: PersistedOpportunityEvaluation = {
      ...shape,
      evaluation: parseOpportunityEvaluation(shape.evaluation),
    };
    await mkdir(dirname(this.#path), { recursive: true });

    await withFileLock(this.#path, async () => {
      await this.#repairTailBeforeAppend();
      const key = evaluationResultKey(parsed.requestId, parsed.evaluatorId);
      const rows = await this.#readAll();
      if (rows.some((row) => evaluationResultKey(row.requestId, row.evaluatorId) === key)) return;
      await appendFile(this.#path, `${canonicalJson(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  async list(limit?: number): Promise<readonly PersistedOpportunityEvaluation[]> {
    const rows = (await this.#readAll()).sort(compareEvaluationRows);
    if (limit === undefined) return Object.freeze(rows);
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return Object.freeze(rows.slice(0, bounded));
  }

  #claimPath(key: string): string {
    return join(`${this.#path}.claims`, `${canonicalHash({ key }).slice(0, 48)}.claim`);
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
        if (parsePersistedRecord(raw) !== undefined) {
          await appendFile(this.#path, "\n", { encoding: "utf8" });
          return;
        }
      } catch {
        // Fall through and remove the incomplete/invalid final record.
      }
    }
    await truncate(this.#path, tailStart);
  }

  async #readAll(): Promise<PersistedOpportunityEvaluation[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: PersistedOpportunityEvaluation[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }
      const parsed = parsePersistedRecord(raw);
      if (parsed !== undefined) rows.push(parsed);
    }
    return rows;
  }
}
