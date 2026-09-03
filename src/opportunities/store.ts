/**
 * Small append-only JSONL store for discovery signals.
 *
 * Opportunity ingestion is intentionally kept independent from the existing
 * commerce SQLite schema while the evaluator is still evolving. This gives the
 * watcher durable deduplication without forcing transient Reddit/WebMCP fields
 * into the mature WorkCandidate tables. The file can later be migrated into the
 * canonical database behind the same store interface.
 */
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../core/ids.js";
import {
  parseOpportunityCandidate,
  type OpportunityCandidate,
} from "./models.js";
import { withFileLock } from "./file-lock.js";

export interface OpportunityStore {
  seenIds(): Promise<ReadonlySet<string>>;
  saveMany(candidates: readonly OpportunityCandidate[]): Promise<number>;
  list(limit?: number): Promise<readonly OpportunityCandidate[]>;
}

export class JsonlOpportunityStore implements OpportunityStore {
  public constructor(private readonly path: string) {}

  public async seenIds(): Promise<ReadonlySet<string>> {
    const rows = await this.readAll();
    return new Set(rows.map((row) => row.id));
  }

  public async saveMany(candidates: readonly OpportunityCandidate[]): Promise<number> {
    if (candidates.length === 0) return 0;
    await mkdir(dirname(this.path), { recursive: true });

    return withFileLock(this.path, async () => {
      await this.repairTailBeforeAppend();
      const existing = new Set((await this.readAll()).map((row) => row.id));
      const fresh: OpportunityCandidate[] = [];
      for (const raw of candidates) {
        const candidate = parseOpportunityCandidate(raw);
        if (existing.has(candidate.id)) continue;
        existing.add(candidate.id);
        fresh.push(candidate);
      }
      if (fresh.length === 0) return 0;
      const payload = `${fresh.map((candidate) => canonicalJson(candidate)).join("\n")}\n`;
      await appendFile(this.path, payload, { encoding: "utf8", mode: 0o600 });
      return fresh.length;
    });
  }

  public async list(limit = 500): Promise<readonly OpportunityCandidate[]> {
    const rows = await this.readAll();
    return rows
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit));
  }

  /**
   * JSONL append must start on a record boundary. A crash can leave either a
   * complete final JSON object without its newline, or a genuinely truncated
   * object. Preserve the former by adding the delimiter; remove only the latter.
   * Byte offsets are used so non-ASCII text cannot make a string index unsafe for
   * `truncate()`.
   */
  private async repairTailBeforeAppend(): Promise<void> {
    let body: Buffer;
    try {
      body = await readFile(this.path);
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
        parseOpportunityCandidate(JSON.parse(tail));
        await appendFile(this.path, "\n", { encoding: "utf8" });
        return;
      } catch {
        // Invalid final record: remove exactly the incomplete tail. Earlier
        // newline-delimited records remain untouched.
      }
    }

    await truncate(this.path, tailStart);
  }

  private async readAll(): Promise<OpportunityCandidate[]> {
    let body: string;
    try {
      body = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const out: OpportunityCandidate[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      try {
        out.push(parseOpportunityCandidate(parsed));
      } catch {
        // A corrupt/legacy line is ignored rather than poisoning the entire
        // append-only store. New writes are always schema-validated above.
      }
    }
    return out;
  }
}
