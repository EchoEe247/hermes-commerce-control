/**
 * Evidence provenance rules.
 *
 * The four classes are ordered by strength:
 *
 *   tentative < inferred < observed < verified
 *
 * An adapter may always *weaken* a classification. Strengthening one requires
 * authoritative proof, and `upgradeGuard` refuses the transition otherwise. This
 * is the rule that stops a marketplace's own claim that a bounty is funded from
 * becoming `verified` simply because the platform said so confidently.
 */
import { CommerceError } from "../core/errors.js";
import type { EvidenceClass, EvidenceRecord, PlatformId, SourceType } from "../core/models.js";
import { hashCanonical } from "./hashing.js";
import { sanitizeText } from "./sanitize.js";

const STRENGTH: Readonly<Record<EvidenceClass, number>> = Object.freeze({
  tentative: 0,
  inferred: 1,
  observed: 2,
  verified: 3,
});

/**
 * Validates an evidence-class transition.
 *
 * @param from current classification
 * @param to requested classification
 * @param hasAuthoritativeProof true only when a cryptographic / on-chain /
 *        authoritative machine proof backs the stronger claim
 */
export function upgradeGuard(
  from: EvidenceClass,
  to: EvidenceClass,
  hasAuthoritativeProof: boolean,
): EvidenceClass {
  if (STRENGTH[to] <= STRENGTH[from]) return to;
  if (hasAuthoritativeProof) return to;
  throw new CommerceError(
    "SCHEMA_VIOLATION",
    `refusing silent EVIDENCE upgrade from "${from}" to "${to}" without authoritative proof`,
    { from, to },
  );
}

export interface MakeEvidenceInput {
  readonly platform: PlatformId;
  readonly fact: string;
  readonly value: string;
  readonly classification: EvidenceClass;
  readonly sourceType: SourceType;
  readonly sourceRef: string;
  readonly capturedAt: string;
  readonly rawPath?: string | undefined;
}

/** Builds a sanitized, hashed evidence record. */
export function makeEvidence(input: MakeEvidenceInput): EvidenceRecord {
  const value = sanitizeText(input.value);
  const sourceRef = sanitizeText(input.sourceRef);
  const record = {
    platform: input.platform,
    fact: input.fact,
    value,
    classification: input.classification,
    sourceType: input.sourceType,
    sourceRef,
    capturedAt: input.capturedAt,
  };
  return Object.freeze({
    ...record,
    hash: hashCanonical(record),
    rawPath: input.rawPath,
  });
}
