/**
 * Canonical identity and hashing.
 *
 * Canonical service identity is derived from the normalized resource URL, HTTP
 * method, protocol, network and receiving address. This is what allows the same
 * x402 service observed through CDP Bazaar, Agent402 and PipRail to collapse
 * into one canonical result instead of three near-duplicates.
 */
import { createHash } from "node:crypto";
import { CommerceError } from "./errors.js";

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

/** Stable stringify with lexically ordered object keys at every depth. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = sortValue(entry);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 of the canonical JSON form of a value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Normalizes a resource URL for identity purposes.
 *
 * Lowercases scheme and host, drops the default port, drops the fragment,
 * sorts query parameters, and removes a single trailing slash from a non-root
 * path. Path case is preserved because paths are case-sensitive.
 */
export function normalizeResourceUrl(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new CommerceError("INVALID_URL", "resource URL must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CommerceError("INVALID_URL", `unparseable URL: ${JSON.stringify(input)}`);
  }
  if (!ALLOWED_URL_SCHEMES.has(url.protocol)) {
    throw new CommerceError("INVALID_URL", `unsupported URL scheme: ${url.protocol}`);
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port !== "" && url.port === DEFAULT_PORTS[url.protocol]) url.port = "";

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  if (url.pathname === "") url.pathname = "/";

  const params = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);

  // Credentials are never part of canonical identity and must not be retained.
  url.username = "";
  url.password = "";

  return url.toString();
}

export interface ServiceIdentityInput {
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network?: string | undefined;
  readonly payTo?: string | undefined;
}

/**
 * Deterministic canonical service ID.
 *
 * Case differences in scheme/host/method/protocol/payTo collapse; differences
 * in path, method, protocol, network or payTo do not. An absent network or
 * payTo is represented by an explicit sentinel so "unknown" is stable and
 * distinguishable from any real value.
 */
export function canonicalServiceId(input: ServiceIdentityInput): string {
  const identity = {
    resourceUrl: normalizeResourceUrl(input.resourceUrl),
    method: normalizeMethod(input.method),
    protocol: input.protocol.trim().toLowerCase(),
    network: input.network === undefined ? "\u0000unknown" : input.network.trim().toLowerCase(),
    payTo: input.payTo === undefined ? "\u0000unknown" : input.payTo.trim().toLowerCase(),
  };
  return `svc_${canonicalHash(identity).slice(0, 32)}`;
}

export interface WorkIdentityInput {
  readonly source: string;
  readonly externalId: string;
}

/**
 * Deterministic canonical work ID.
 *
 * Work identity is scoped per source: bounty "42" on Agent Bounties and bounty
 * "42" on BountyBook are different pieces of work, so the source is part of the
 * identity rather than something to be merged away.
 */
export function canonicalWorkId(input: WorkIdentityInput): string {
  const identity = {
    source: input.source.trim().toLowerCase(),
    externalId: input.externalId.trim(),
  };
  return `wrk_${canonicalHash(identity).slice(0, 32)}`;
}

/** Uppercases and validates an HTTP method token. */
export function normalizeMethod(method: string): string {
  const upper = String(method ?? "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(upper)) {
    throw new CommerceError("INVALID_INPUT", `invalid HTTP method: ${JSON.stringify(method)}`);
  }
  return upper;
}

/** Deterministic operation ID derived from type, timestamp and a counter. */
export function operationId(type: string, isoTime: string, seq: number): string {
  return `op_${canonicalHash({ type, isoTime, seq }).slice(0, 24)}`;
}

/** Deterministic intent ID derived from the intent's non-secret canonical body. */
export function intentId(kind: string, body: unknown): string {
  return `int_${kind}_${canonicalHash(body).slice(0, 24)}`;
}
