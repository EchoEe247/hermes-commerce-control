/**
 * Per-adapter evidence collector.
 *
 * Each adapter invocation receives its own collector. The collector is the only
 * sanctioned way for an adapter to record a fact, which keeps classification
 * honest: the `verified` helper physically requires a proof flag, so an adapter
 * cannot reach `verified` by simply passing the string.
 */
import type { EvidenceClass, EvidenceRecord, PlatformId, SourceType } from "../core/models.js";
import { CommerceError } from "../core/errors.js";
import { hashCanonical } from "./hashing.js";
import { makeEvidence } from "./provenance.js";
import { sanitize } from "./sanitize.js";

export interface SanitizedCapture {
  readonly label: string;
  readonly sanitized: unknown;
  readonly hash: string;
  readonly capturedAt: string;
}

export type Clock = () => string;

export class EvidenceCollector {
  private readonly items: EvidenceRecord[] = [];
  private readonly captures: SanitizedCapture[] = [];

  public constructor(
    private readonly platform: PlatformId,
    private readonly clock: Clock = () => new Date().toISOString(),
  ) {}

  /** Records a fact the platform returned directly. */
  public observe(
    fact: string,
    value: string,
    sourceType: SourceType,
    sourceRef: string,
  ): EvidenceRecord {
    return this.push("observed", fact, value, sourceType, sourceRef);
  }

  /** Records a fact derived from observed evidence. */
  public infer(
    fact: string,
    value: string,
    sourceType: SourceType,
    sourceRef: string,
  ): EvidenceRecord {
    return this.push("inferred", fact, value, sourceType, sourceRef);
  }

  /** Records an incomplete or ambiguous fact. */
  public tentative(
    fact: string,
    value: string,
    sourceType: SourceType,
    sourceRef: string,
  ): EvidenceRecord {
    return this.push("tentative", fact, value, sourceType, sourceRef);
  }

  /**
   * Records a cryptographically/authoritatively proven fact.
   *
   * `hasAuthoritativeProof` must be true. The parameter exists so the callsite
   * has to state the claim explicitly and a reviewer can grep for it.
   */
  public verified(
    fact: string,
    value: string,
    sourceType: SourceType,
    sourceRef: string,
    hasAuthoritativeProof: boolean,
  ): EvidenceRecord {
    if (!hasAuthoritativeProof) {
      throw new CommerceError(
        "SCHEMA_VIOLATION",
        `refusing to classify "${fact}" as verified without authoritative proof`,
        { fact, platform: this.platform },
      );
    }
    return this.push("verified", fact, value, sourceType, sourceRef);
  }

  /**
   * Sanitizes and hashes a raw payload for optional evidence export.
   *
   * A raw capture is itself evidence, so this also appends an `observed` record
   * carrying the capture's provenance and hash. That keeps the evidence list a
   * complete account of what the adapter saw, rather than leaving captures in a
   * parallel structure that a receipt could omit.
   */
  public capture(label: string, raw: unknown): SanitizedCapture {
    const hash = hashCanonical(raw);
    const capture: SanitizedCapture = Object.freeze({
      label,
      sanitized: sanitize(raw),
      hash,
      capturedAt: this.clock(),
    });
    this.captures.push(capture);
    this.push("observed", label, hash, "http_api", `capture:${label}`);
    return capture;
  }

  public records(): readonly EvidenceRecord[] {
    return Object.freeze([...this.items]);
  }

  public sanitizedCaptures(): readonly SanitizedCapture[] {
    return Object.freeze([...this.captures]);
  }

  private push(
    classification: EvidenceClass,
    fact: string,
    value: string,
    sourceType: SourceType,
    sourceRef: string,
  ): EvidenceRecord {
    const record = makeEvidence({
      platform: this.platform,
      fact,
      value,
      classification,
      sourceType,
      sourceRef,
      capturedAt: this.clock(),
    });
    this.items.push(record);
    return record;
  }
}
