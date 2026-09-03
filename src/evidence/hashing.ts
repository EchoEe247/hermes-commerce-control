/**
 * Hashing for evidence integrity.
 *
 * Hashes are always computed over the *sanitized* form. Hashing raw bytes that
 * contain a credential would make the credential's presence provable and would
 * couple the hash to material that must never be retained.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/ids.js";
import { sanitize } from "./sanitize.js";

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 over the canonical JSON of the sanitized value. */
export function hashCanonical(value: unknown): string {
  return hashBytes(canonicalJson(sanitize(value)));
}

/** SHA-256 over canonical JSON without sanitization; for local-only identity. */
export function hashCanonicalRaw(value: unknown): string {
  return hashBytes(canonicalJson(value));
}
