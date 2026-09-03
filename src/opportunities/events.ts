/**
 * Push/event ingestion seam for webhook, email, and other externally delivered
 * opportunity signals.
 *
 * The commerce control plane does not own inbound HTTP servers, webhook secrets,
 * mail credentials, or signature verification. A local/runtime-specific receiver
 * verifies and sanitizes an event, then hands the payload to a source normalizer
 * here. This keeps secrets out of the read-only control plane while letting push
 * sources share canonical IDs, dedupe, storage, and downstream triage.
 */
import { CommerceError } from "../core/errors.js";
import { dedupeOpportunities } from "./dedupe.js";
import {
  parseOpportunityCandidate,
  type OpportunityCandidate,
  type OpportunitySourceId,
} from "./models.js";
import type { OpportunityStore } from "./store.js";

export interface OpportunityEventContext {
  readonly clock: () => string;
}

export interface OpportunityEventNormalizer {
  readonly id: OpportunitySourceId;
  normalize(
    payload: unknown,
    context: OpportunityEventContext,
  ): readonly OpportunityCandidate[];
}

export interface OpportunityEventIngestResult {
  readonly source: OpportunitySourceId;
  readonly normalized: number;
  readonly duplicatesDropped: number;
  readonly persisted: number;
  readonly results: readonly OpportunityCandidate[];
}

/**
 * Normalize one already-authenticated/sanitized external event and persist only
 * candidates not already present in the opportunity store. Runtime validation
 * happens here even though the normalizer is typed: inbound payloads are untrusted.
 * The declared normalizer source is authoritative; a normalizer cannot smuggle a
 * candidate attributed to a different source into the shared opportunity store.
 */
export async function normalizeAndPersistEvent(
  normalizer: OpportunityEventNormalizer,
  payload: unknown,
  store: OpportunityStore,
  clock: () => string = (): string => new Date().toISOString(),
): Promise<OpportunityEventIngestResult> {
  const normalized = normalizer
    .normalize(payload, { clock })
    .map((candidate) => {
      const parsed = parseOpportunityCandidate(candidate);
      if (parsed.source !== normalizer.id) {
        throw new CommerceError(
          "SCHEMA_VIOLATION",
          `opportunity event normalizer ${normalizer.id} emitted candidate source ${parsed.source}`,
        );
      }
      return parsed;
    });
  const seen = await store.seenIds();
  const deduped = dedupeOpportunities(normalized, seen);
  const persisted = await store.saveMany(deduped.fresh);

  return Object.freeze({
    source: normalizer.id,
    normalized: normalized.length,
    duplicatesDropped: deduped.duplicates.length,
    persisted,
    results: deduped.fresh,
  });
}
