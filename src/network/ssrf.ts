/**
 * SSRF address and URL validation.
 *
 * Threat model: a marketplace listing, description, metadata field or redirect
 * chain is attacker-controlled and may try to make this process fetch
 * `http://127.0.0.1:8081/`, `http://169.254.169.254/` (cloud metadata), a LAN
 * device, or a non-HTTP scheme such as `file://`.
 *
 * Two layers defend against that, and both are needed:
 *
 *  - This module validates the URL *and* every resolved IP literal.
 *  - safe-fetch.ts validates again at connection time, because a preflight DNS
 *    lookup alone is defeated by DNS rebinding: the name can resolve to a public
 *    address during the check and to 127.0.0.1 when the socket actually opens.
 */
import { isIP } from "node:net";
import { CommerceError } from "../core/errors.js";

/** Hostnames that always refer to the local machine. */
export const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "local",
  "broadcasthost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** DNS suffixes that denote a local/private namespace. */
const BLOCKED_SUFFIXES: readonly string[] = Object.freeze([
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".localhost",
]);

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

function blocked(target: string, why: string): never {
  throw new CommerceError("SSRF_BLOCKED", `${why}: ${JSON.stringify(target)}`, { target });
}

/** Parses an IPv4 dotted/short/decimal/octal/hex form into 32-bit big-endian. */
function parseIpv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // Short forms: a, a.b, a.b.c — the final part absorbs the remaining octets.
  const n = values.length;
  const last = values[n - 1];
  if (last === undefined) return null;
  const maxLast = 2 ** (8 * (4 - n + 1));
  if (last >= maxLast) return null;
  for (let i = 0; i < n - 1; i += 1) {
    const v = values[i];
    if (v === undefined || v > 255) return null;
  }

  // The leading n-1 parts each occupy 8 bits; the final part absorbs the
  // remaining 8 * (5 - n) bits. For 4 parts that is a plain dotted quad; for
  // 1 part it is the 32-bit decimal form such as 2130706433 == 127.0.0.1.
  let head = 0;
  for (let i = 0; i < n - 1; i += 1) {
    head = (head << 8) | (values[i] as number);
  }
  const result = head * 2 ** (8 * (5 - n)) + last;
  if (result > 0xffffffff) return null;
  return result >>> 0;
}

/** True when a 32-bit IPv4 value falls in a non-public range. */
function isBlockedIpv4Int(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 (test)
  if (a === 192 && b === 88) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // documentation
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 literal to its eight 16-bit groups. */
function expandIpv6(host: string): number[] | null {
  let text = host.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // Strip a zone index such as %eth0.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // Trailing embedded IPv4, e.g. ::ffff:127.0.0.1
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }

  const doubleColon = text.indexOf("::");
  let headParts: string[];
  let tailParts: string[];
  if (doubleColon === -1) {
    headParts = text === "" ? [] : text.split(":");
    tailParts = [];
  } else {
    const headText = text.slice(0, doubleColon);
    const tailText = text.slice(doubleColon + 2);
    headParts = headText === "" ? [] : headText.split(":");
    tailParts = tailText === "" ? [] : tailText.split(":");
  }

  const toGroups = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (const p of parts) {
      if (p === "" || !/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };

  const head = toGroups(headParts);
  const tailMid = toGroups(tailParts);
  if (head === null || tailMid === null) return null;

  const explicit = head.length + tailMid.length + tail.length;
  if (explicit > 8) return null;
  if (doubleColon === -1 && explicit !== 8) return null;

  const fill = new Array<number>(8 - explicit).fill(0);
  return [...head, ...fill, ...tailMid, ...tail];
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (
    g0 === undefined ||
    g1 === undefined ||
    g2 === undefined ||
    g3 === undefined ||
    g4 === undefined ||
    g5 === undefined ||
    g6 === undefined ||
    g7 === undefined
  ) {
    return true;
  }

  const allZeroHigh = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::1 loopback and :: unspecified
  if (allZeroHigh && g5 === 0 && g6 === 0 && (g7 === 1 || g7 === 0)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroHigh && (g5 === 0xffff || g5 === 0)) {
    const v4 = ((g6 << 16) | g7) >>> 0;
    if (isBlockedIpv4Int(v4)) return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 wrapping a private v4
  if (g0 === 0x0064 && g1 === 0xff9b) {
    const v4 = ((g6 << 16) | g7) >>> 0;
    if (isBlockedIpv4Int(v4)) return true;
  }
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  return false;
}

/**
 * True when a bare address literal (or an ambiguous host string) must not be
 * connected to.
 *
 * An unparseable input returns true: failing closed is the correct behaviour for
 * a security check.
 */
export function isBlockedAddress(address: string): boolean {
  const host = address.trim();
  if (host === "") return true;

  const family = isIP(host);
  if (family === 4) {
    const v4 = parseIpv4ToInt(host);
    return v4 === null ? true : isBlockedIpv4Int(v4);
  }
  if (family === 6) {
    const groups = expandIpv6(host);
    return groups === null ? true : isBlockedIpv6(groups);
  }

  // Not a canonical literal. It may still be an alternate IPv4 encoding
  // (decimal/octal/hex/short form) or a bracketed IPv6 form.
  if (host.startsWith("[")) {
    const groups = expandIpv6(host);
    return groups === null ? true : isBlockedIpv6(groups);
  }
  if (/^[0-9a-fA-FxX.]+$/.test(host)) {
    const v4 = parseIpv4ToInt(host);
    if (v4 !== null) return isBlockedIpv4Int(v4);
  }

  // A genuine DNS name: not an address, so this check does not apply.
  return false;
}

/** Throws SSRF_BLOCKED when the address literal is not publicly routable. */
export function assertPublicAddress(address: string, context = "address"): void {
  if (isBlockedAddress(address)) {
    blocked(address, `${context} resolves to a blocked non-public range`);
  }
}

/** True when a hostname is in a local/private namespace by name. */
export function isBlockedHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host === "." || host === "..") return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // A single-label hostname with no dot is treated as local. Such a name is
  // resolved through the host's DNS search domains, so "http://intranet/" or
  // the WHATWG parse of "http:///x" (hostname "x") can reach an internal
  // service. Every legitimate marketplace endpoint this control plane uses is
  // a dotted FQDN, so requiring a dot costs nothing and closes the vector.
  if (!host.includes(".") && isIP(host) === 0) return true;

  return false;
}

/**
 * Validates a URL before any connection is attempted.
 *
 * Rejects non-HTTP schemes, embedded credentials, local hostnames and any host
 * that is a literal in a blocked range. Returns the parsed URL for the caller.
 */
export function assertAllowedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CommerceError("INVALID_URL", `unparseable URL: ${JSON.stringify(input)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    blocked(input, `scheme ${url.protocol} is not permitted; only http and https are allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    blocked(input, "URLs carrying embedded credentials are refused");
  }

  const hostname = url.hostname;
  if (hostname === "") blocked(input, "URL has no host");
  if (isBlockedHostname(hostname)) blocked(hostname, "hostname is in a local/private namespace");
  if (isBlockedAddress(hostname)) blocked(hostname, "host is a literal in a blocked range");

  return url;
}
