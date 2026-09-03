/**
 * Secret sanitization.
 *
 * Everything that leaves this process for a durable destination (SQLite, a
 * repository export, a receipt, a log line) passes through here first.
 *
 * Two complementary strategies, because either alone is insufficient:
 *
 *  1. Key-based redaction. A value under a credential-bearing key is redacted
 *     regardless of what it looks like, because a short token is otherwise
 *     indistinguishable from a price.
 *  2. Value-based redaction. A secret-shaped value is redacted even under a
 *     benign key, because an upstream may return `{"note": "<a bearer token>"}`
 *     and a marketplace description is attacker-controlled.
 */

export const REDACTED = "[REDACTED]";

/**
 * Key names whose values are always redacted.
 *
 * Deliberately broad: a false positive costs a redacted price field in an
 * evidence capture, while a false negative could publish a credential.
 */
export const SECRET_KEY_PATTERN =
  /(authorization|auth[-_]?token|api[-_]?key|apikey|x[-_]?api[-_]?key|cookie|set[-_]?cookie|private[-_]?key|privatekey|mnemonic|seed[-_]?phrase|seedphrase|\bseed\b|\bnwc\b|nostr[+_-]?walletconnect|wallet[-_]?secret|signing[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|\btoken\b|secret|password|passphrase|session|credential|payment[-_]?signature|x[-_]?payment|preimage|recovery)/i;

/** Value shapes that are redacted wherever they appear. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  // Bearer / Basic credentials in free text or a header value.
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // JWT.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
  // 32-byte hex, i.e. an EVM private key with or without the 0x prefix.
  /\b0x[0-9a-fA-F]{64}\b/g,
  /\b[0-9a-fA-F]{64}\b/g,
  // NWC / wallet-connect URI.
  /nostr\+walletconnect:\/\/[^\s"']+/gi,
  // Common provider key prefixes.
  /\b(?:sk|rk|ak|pk)_(?:live|test|prod)?_?[A-Za-z0-9]{8,}/g,
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  // KEY=value / SECRET=value assignments in a shell-like string.
  /\b(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET|TOKEN|API_KEY|PASSWORD)\s*=\s*\S+/gi,
]);

/** Recognizable BIP-39-style phrase of 12 or more lowercase words. */
const MNEMONIC_PHRASE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

/** Redacts secret-shaped substrings inside a free-text string. */
export function sanitizeText(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(MNEMONIC_PHRASE, REDACTED);
  return out;
}

const MAX_DEPTH = 24;

/**
 * Recursively sanitizes an arbitrary JSON-like value.
 *
 * Depth is bounded so a hostile deeply-nested payload cannot exhaust the stack,
 * and cycles are handled by a seen-set.
 */
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") {
    // Numbers, booleans, undefined, bigint, symbol: nothing to redact.
    return typeof value === "bigint" ? value.toString() : value;
  }

  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1, seen));
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitize(entry, depth + 1, seen);
  }
  return out;
}

/** Convenience: sanitize then serialize deterministically for hashing/export. */
export function sanitizedJson(value: unknown): string {
  return JSON.stringify(sanitize(value));
}

/**
 * Final guard used immediately before a repository write.
 *
 * Returns the list of secret patterns still present. A non-empty result means
 * the caller must not persist the content.
 */
export function findResidualSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    if (re.test(text)) hits.push(pattern.source);
  }
  return hits;
}
