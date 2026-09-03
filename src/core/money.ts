/**
 * Authoritative money handling.
 *
 * Every authoritative amount in this control plane is a decimal *string* or an
 * atomic integer *string*. Binary floating point is never used for a stored or
 * compared authoritative amount, because `0.1 + 0.2 !== 0.3` is not an
 * acceptable property for a price or a bounty reward.
 *
 * Scientific notation, thousands separators, currency symbols and unit suffixes
 * are all rejected rather than coerced: an upstream that sends `1e-3` has not
 * told us unambiguously what it means, so the correct action is to reject the
 * value and let the caller classify the price as unknown.
 */
import { CommerceError } from "./errors.js";

/** Plain, unsigned decimal: digits, optional single dot, at least one digit. */
const PLAIN_DECIMAL = /^\+?(?:\d+(?:\.\d+)?|\.\d+)$/;
/** Unsigned integer, used for atomic amounts. */
const PLAIN_INTEGER = /^\+?\d+$/;

function reject(value: unknown, why: string): never {
  throw new CommerceError("INVALID_AMOUNT", `${why}: ${JSON.stringify(String(value))}`);
}

/**
 * Normalizes a plain decimal string to a canonical form:
 * no leading `+`, no redundant leading zeroes, no trailing fractional zeroes,
 * no bare leading dot, and no trailing dot.
 */
export function normalizeDecimalString(input: string): string {
  if (typeof input !== "string") reject(input, "amount must be a string");
  const trimmed = input.trim();
  if (!PLAIN_DECIMAL.test(trimmed)) reject(input, "not a plain decimal string");

  const unsigned = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf(".");
  let intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  let fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);

  intPart = intPart.replace(/^0+(?=\d)/, "");
  if (intPart === "") intPart = "0";
  fracPart = fracPart.replace(/0+$/, "");

  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

/**
 * Parses an authoritative amount (price, reward, balance).
 *
 * Rejects anything non-plain-decimal, and rejects negatives outright because no
 * authoritative amount in this system is legitimately negative.
 */
export function parseAuthoritativeAmount(input: string): string {
  if (typeof input !== "string") reject(input, "amount must be a string");
  const trimmed = input.trim();
  if (trimmed.startsWith("-")) reject(input, "negative amounts are not valid");
  return normalizeDecimalString(trimmed);
}

/** True when the value is a parseable authoritative amount. */
export function isAuthoritativeAmount(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    parseAuthoritativeAmount(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compares two decimal strings exactly.
 *
 * Returns -1, 0 or 1. Precision is unbounded: comparison is performed on
 * zero-padded digit strings, so values beyond double precision still order
 * correctly.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const na = normalizeDecimalString(a);
  const nb = normalizeDecimalString(b);

  const [aInt = "0", aFrac = ""] = na.split(".");
  const [bInt = "0", bFrac = ""] = nb.split(".");

  const intWidth = Math.max(aInt.length, bInt.length);
  const aIntPad = aInt.padStart(intWidth, "0");
  const bIntPad = bInt.padStart(intWidth, "0");
  if (aIntPad < bIntPad) return -1;
  if (aIntPad > bIntPad) return 1;

  const fracWidth = Math.max(aFrac.length, bFrac.length);
  const aFracPad = aFrac.padEnd(fracWidth, "0");
  const bFracPad = bFrac.padEnd(fracWidth, "0");
  if (aFracPad < bFracPad) return -1;
  if (aFracPad > bFracPad) return 1;
  return 0;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new CommerceError("INVALID_AMOUNT", `unsupported asset decimals: ${String(decimals)}`);
  }
}

/**
 * Converts an atomic integer string to a decimal string for a given asset.
 * Example: atomicToDecimalString("20000", 6) === "0.02"
 */
export function atomicToDecimalString(atomic: string, decimals: number): string {
  if (typeof atomic !== "string") reject(atomic, "atomic amount must be a string");
  assertDecimals(decimals);
  const trimmed = atomic.trim();
  if (!PLAIN_INTEGER.test(trimmed)) reject(atomic, "atomic amount must be an unsigned integer");

  const digits = (trimmed.startsWith("+") ? trimmed.slice(1) : trimmed).replace(/^0+(?=\d)/, "");
  if (decimals === 0) return normalizeDecimalString(digits);

  const padded = digits.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  return normalizeDecimalString(`${intPart}.${fracPart}`);
}

/**
 * Converts a decimal string to an atomic integer string for a given asset.
 * Rejects values with more precision than the asset can represent rather than
 * silently rounding, because rounding a price is a correctness bug.
 */
export function decimalToAtomicString(decimal: string, decimals: number): string {
  assertDecimals(decimals);
  const normalized = parseAuthoritativeAmount(decimal);
  const [intPart = "0", fracPart = ""] = normalized.split(".");
  if (fracPart.length > decimals) {
    reject(decimal, `amount has more precision than the asset's ${String(decimals)} decimals`);
  }
  const atomic = `${intPart}${fracPart.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return atomic === "" ? "0" : atomic;
}

/** Sums decimal strings exactly via atomic conversion at a fixed scale. */
export function sumDecimalStrings(values: readonly string[], decimals: number): string {
  assertDecimals(decimals);
  let total = 0n;
  for (const v of values) total += BigInt(decimalToAtomicString(v, decimals));
  return atomicToDecimalString(total.toString(), decimals);
}

/**
 * Best-effort numeric projection for *ranking only*.
 *
 * Never use the result as an authoritative amount, for persistence, or for a
 * payment field. It exists so scoring can do arithmetic on a bounded scale.
 */
export function toRankingNumber(decimal: string): number {
  return Number(normalizeDecimalString(decimal));
}
