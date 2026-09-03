/**
 * Typed error codes for the commerce control plane.
 *
 * Codes are stable strings because they cross the CLI/MCP boundary and appear
 * in receipts and evidence. Renaming one is a breaking change for reviewers.
 */
export const COMMERCE_ERROR_CODES = [
  // Validation / normalization
  "INVALID_AMOUNT",
  "INVALID_URL",
  "INVALID_INPUT",
  "SCHEMA_VIOLATION",
  // Network boundary
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_MALFORMED",
  "SSRF_BLOCKED",
  "RESPONSE_TOO_LARGE",
  "TOO_MANY_REDIRECTS",
  // Policy boundary
  "EXTERNAL_WRITE_DISABLED",
  "EXTERNAL_WRITE_NOT_AUTHORIZED",
  "LIVE_VALUE_MOVEMENT_DISABLED",
  "SECRET_ACCESS_FORBIDDEN",
  "WALLET_REQUIRED",
  "POLICY_BLOCKED",
  // Adapter / capability
  "UNSUPPORTED_OPERATION",
  "ADAPTER_DISABLED",
  "NOT_FOUND",
  // Local runtime
  "STATE_ERROR",
  "CONFIG_ERROR",
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

/** JSON-safe, non-secret structured detail attached to an error. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * A typed, JSON-serializable error.
 *
 * The code is always included in `message` so that assertions and log scans
 * can match on the code even after the error crosses a process boundary.
 */
export class CommerceError extends Error {
  public readonly code: CommerceErrorCode;
  public readonly details: ErrorDetails;

  public constructor(code: CommerceErrorCode, message: string, details: ErrorDetails = {}) {
    super(`${code}: ${message}`);
    this.name = "CommerceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  public toJSON(): { code: CommerceErrorCode; message: string; details: ErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isCommerceError(value: unknown): value is CommerceError {
  return value instanceof CommerceError;
}

/** Narrows an unknown thrown value into a CommerceError without losing information. */
export function asCommerceError(
  value: unknown,
  fallbackCode: CommerceErrorCode = "UPSTREAM_UNAVAILABLE",
): CommerceError {
  if (isCommerceError(value)) return value;
  if (value instanceof Error) {
    return new CommerceError(fallbackCode, value.message, { cause: value.name });
  }
  return new CommerceError(fallbackCode, String(value));
}
