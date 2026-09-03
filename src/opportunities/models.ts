/**
 * Provider-independent opportunity ingestion models.
 *
 * These types intentionally sit beside the existing marketplace WorkCandidate
 * model instead of widening PlatformId. A Reddit post, RSS item, WebMCP result,
 * or browser-observed listing is a discovery signal first; only later should a
 * validated opportunity be promoted into a commerce/workflow-specific shape.
 */
import { z } from "zod";
import { CommerceError } from "../core/errors.js";
import { canonicalHash, normalizeResourceUrl } from "../core/ids.js";

export const OPPORTUNITY_SOURCE_IDS = [
  "reddit_rss",
  "redditapis_monitor",
  "redditalert_email",
  "generic_rss",
  "webmcp",
  "playwright",
] as const;
export type OpportunitySourceId = (typeof OPPORTUNITY_SOURCE_IDS)[number];

export interface OpportunityCandidate {
  readonly id: string;
  readonly source: OpportunitySourceId;
  readonly externalId: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly url?: string | undefined;
  readonly author?: string | undefined;
  readonly community?: string | undefined;
  readonly postedAt?: string | undefined;
  readonly observedAt: string;
  readonly tags: readonly string[];
  /** Small, non-secret source facts useful for later enrichment/debugging. */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Runtime validation boundary used for adapter output, event normalization, and
 * persisted JSONL replay. A source cannot smuggle arbitrary nested objects into
 * the evaluator just because TypeScript trusted its compile-time return type.
 */
export const opportunityCandidateSchema = z
  .object({
    id: z.string().min(1).max(128),
    source: z.enum(OPPORTUNITY_SOURCE_IDS),
    externalId: z.string().min(1).max(1024),
    title: z.string().min(1).max(20_000),
    body: z.string().max(1_000_000).optional(),
    url: z.string().url().max(20_000).optional(),
    author: z.string().max(1024).optional(),
    community: z.string().max(1024).optional(),
    postedAt: z.string().max(128).optional(),
    observedAt: z.string().min(1).max(128),
    tags: z.array(z.string().min(1).max(1024)).max(256),
    metadata: z.record(z.string().max(1024), z.string().max(20_000)),
  })
  .strict();

export function parseOpportunityCandidate(value: unknown): OpportunityCandidate {
  try {
    return opportunityCandidateSchema.parse(value) as OpportunityCandidate;
  } catch (error) {
    throw new CommerceError("SCHEMA_VIOLATION", "opportunity source returned invalid candidate", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

export interface OpportunityQuery {
  readonly q?: string | undefined;
  readonly communities?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface OpportunitySourceStatus {
  readonly status: "ok" | "degraded" | "unreachable" | "disabled";
  readonly count: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface OpportunityAggregateResult {
  readonly sources: Readonly<Record<string, OpportunitySourceStatus>>;
  readonly results: readonly OpportunityCandidate[];
  readonly duplicatesDropped: number;
}

export interface OpportunityIdentityInput {
  readonly source: OpportunitySourceId;
  readonly externalId: string;
  readonly url?: string | undefined;
}

/**
 * Stable identity prefers a canonical public URL so the same listing arriving
 * through RSS, a webhook, or a later API adapter collapses to one opportunity.
 * When no URL exists, identity falls back to source + external ID.
 */
export function canonicalOpportunityId(input: OpportunityIdentityInput): string {
  let identity: Readonly<Record<string, string>>;
  if (input.url !== undefined && input.url.trim() !== "") {
    try {
      identity = { url: normalizeResourceUrl(input.url) };
    } catch {
      identity = {
        source: input.source,
        externalId: input.externalId.trim(),
      };
    }
  } else {
    identity = {
      source: input.source,
      externalId: input.externalId.trim(),
    };
  }
  return `opp_${canonicalHash(identity).slice(0, 32)}`;
}
