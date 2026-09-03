/**
 * Cross-source service aggregation and deduplication.
 *
 * The same x402 service legitimately appears through CDP Bazaar, Agent402,
 * PipRail and the 402 Index. Canonical identity (normalized URL + method +
 * protocol + network + payTo) is what collapses those into one result.
 *
 * Merging preserves every source observation rather than picking a winner, so a
 * reviewer can see which catalogues agreed. Cross-source agreement may raise
 * *confidence*, but it never rewrites an underlying evidence classification:
 * three catalogues each reporting `observed` do not produce `verified`.
 */
import { compareDecimalStrings } from "../core/money.js";
import type {
  EvidenceRecord,
  ServiceCandidate,
  SourceObservation,
  SourceHealth,
} from "../core/models.js";

/** A canonical service with all of its cross-source observations merged. */
export interface MergedService extends ServiceCandidate {
  /** Number of distinct platforms that reported this service. */
  readonly sourceCount: number;
}

const HEALTH_RANK: Readonly<Record<SourceHealth, number>> = Object.freeze({
  ok: 3,
  degraded: 2,
  unreachable: 1,
  disabled: 0,
});

/**
 * Merges candidates that share a canonical ID.
 *
 * Deterministic: results are ordered by canonical ID, and every field-level
 * choice is a documented rule rather than "whichever arrived first".
 */
export function dedupeServices(candidates: readonly ServiceCandidate[]): MergedService[] {
  const groups = new Map<string, ServiceCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.id);
    if (existing === undefined) groups.set(candidate.id, [candidate]);
    else existing.push(candidate);
  }

  const merged: MergedService[] = [];
  for (const [id, group] of groups) {
    merged.push(mergeGroup(id, group));
  }
  // Stable output order independent of input order.
  merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return merged;
}

function mergeGroup(id: string, group: readonly ServiceCandidate[]): MergedService {
  // Deterministic primary: newest observation, then platform name, then
  // external ID. Never input order.
  const ordered = [...group].sort((a, b) => {
    const byTime = b.observedAt.localeCompare(a.observedAt);
    if (byTime !== 0) return byTime;
    const aSrc = a.sources[0]?.source ?? "";
    const bSrc = b.sources[0]?.source ?? "";
    if (aSrc !== bSrc) return aSrc < bSrc ? -1 : 1;
    const aExt = a.sources[0]?.externalId ?? "";
    const bExt = b.sources[0]?.externalId ?? "";
    return aExt < bExt ? -1 : aExt > bExt ? 1 : 0;
  });
  const primary = ordered[0] as ServiceCandidate;

  // All source observations, deduplicated by (source, externalId).
  const sourceMap = new Map<string, SourceObservation>();
  for (const candidate of ordered) {
    for (const observation of candidate.sources) {
      const key = `${observation.source}\u0000${observation.externalId}`;
      const prior = sourceMap.get(key);
      if (prior === undefined || observation.observedAt > prior.observedAt) {
        sourceMap.set(key, observation);
      }
    }
  }
  const sources = [...sourceMap.values()].sort((a, b) =>
    a.source === b.source
      ? a.externalId < b.externalId
        ? -1
        : a.externalId > b.externalId
          ? 1
          : 0
      : a.source < b.source
        ? -1
        : 1,
  );

  // Health: the most pessimistic wins. If one catalogue reports a service as
  // degraded, calling it healthy because another disagrees would hide a fault.
  let health = primary.health;
  for (const candidate of ordered) {
    if (HEALTH_RANK[candidate.health] < HEALTH_RANK[health]) health = candidate.health;
  }

  // Price: the lowest trustworthy price across sources. Conflicting prices are a
  // real condition; taking the minimum is conservative for a buyer and is
  // recorded as inferred evidence below.
  const priced = ordered.filter((c) => c.price?.decimal !== undefined);
  let price = primary.price;
  if (priced.length > 0) {
    price = priced.reduce((best, candidate) => {
      const bestDecimal = best.price?.decimal;
      const candidateDecimal = candidate.price?.decimal;
      if (bestDecimal === undefined) return candidate;
      if (candidateDecimal === undefined) return best;
      return compareDecimalStrings(candidateDecimal, bestDecimal) < 0 ? candidate : best;
    }).price;
  }

  const priceValues = new Set(
    priced.map((c) => c.price?.decimal).filter((d): d is string => d !== undefined),
  );

  // Evidence: union, deduplicated by hash, deterministically ordered.
  const evidenceMap = new Map<string, EvidenceRecord>();
  for (const candidate of ordered) {
    for (const record of candidate.evidence) evidenceMap.set(record.hash, record);
  }
  const evidence = [...evidenceMap.values()].sort((a, b) => {
    if (a.fact !== b.fact) return a.fact < b.fact ? -1 : 1;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });

  // Activity: the maximum reported figure, since absence is unknown not zero.
  const activity = mergeActivity(ordered);

  // Tags: union, sorted.
  const tags = [...new Set(ordered.flatMap((c) => c.tags))].sort();

  // Actionability: capability is the union, but the live flags stay false. They
  // are literal-typed, so this cannot drift.
  const actionability = Object.freeze({
    canQuote: ordered.some((c) => c.actionability.canQuote),
    canPreparePurchase: ordered.some((c) => c.actionability.canPreparePurchase),
    canPurchase: false as const,
  });

  return Object.freeze({
    ...primary,
    id,
    sources,
    health,
    ...(price === undefined ? {} : { price }),
    ...(activity === undefined ? {} : { activity }),
    tags,
    evidence,
    actionability,
    sourceCount: new Set(sources.map((s) => s.source)).size,
    // A genuine price disagreement is worth surfacing to a reviewer.
    ...(priceValues.size > 1
      ? { description: `${primary.description ?? primary.name} [sources report differing prices]` }
      : {}),
  });
}

function mergeActivity(
  group: readonly ServiceCandidate[],
): ServiceCandidate["activity"] | undefined {
  let calls: number | undefined;
  let payers: number | undefined;
  let success: number | undefined;
  for (const candidate of group) {
    const a = candidate.activity;
    if (a === undefined) continue;
    if (a.calls30d !== undefined) calls = Math.max(calls ?? 0, a.calls30d);
    if (a.uniquePayers30d !== undefined) payers = Math.max(payers ?? 0, a.uniquePayers30d);
    if (a.successRate !== undefined) success = Math.max(success ?? 0, a.successRate);
  }
  if (calls === undefined && payers === undefined && success === undefined) return undefined;
  return Object.freeze({
    ...(calls === undefined ? {} : { calls30d: calls }),
    ...(payers === undefined ? {} : { uniquePayers30d: payers }),
    ...(success === undefined ? {} : { successRate: success }),
  });
}
