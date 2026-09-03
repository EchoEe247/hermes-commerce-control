/**
 * Canonicalization of marketplace-supplied resource URLs.
 *
 * Why this exists as a separate, shared helper:
 *
 * `normalizeResourceUrl` (core/ids.ts) canonicalizes a URL for *identity*
 * purposes. It validates the scheme but performs no SSRF analysis, because
 * identity and reachability are different concerns and core/ must not depend on
 * the network layer.
 *
 * That distinction bit us. A registry entry declaring
 * `service_url: http://127.0.0.1:8081` normalized cleanly and became a canonical
 * service candidate. Nothing would have been fetched from it, since safe-fetch
 * revalidates at connection time, but a loopback target had still been accepted
 * into canonical state where it could be persisted, exported, ranked and
 * surfaced to Hermes as a legitimate service. Marketplace content is untrusted,
 * so it must not be able to name a local or private host at all.
 *
 * Every adapter that ingests a URL from external data uses this helper, so the
 * check cannot be forgotten in one adapter while present in the others.
 */
import { normalizeResourceUrl } from "../core/ids.js";
import { assertAllowedUrl } from "../network/ssrf.js";

/**
 * Canonicalizes a marketplace-supplied URL and refuses non-public targets.
 *
 * Throws `INVALID_URL` for an unparseable or non-HTTP URL and `SSRF_BLOCKED` for
 * loopback, private, link-local, ULA, metadata or single-label hosts.
 */
export function normalizePublicResourceUrl(input: string): string {
  // Identity normalization first: lowercases the host, drops a default port and
  // the fragment, sorts the query, strips credentials.
  const normalized = normalizeResourceUrl(input);
  // Then the SSRF boundary, on the normalized form, so an alternate encoding
  // cannot slip past by being spelled differently.
  assertAllowedUrl(normalized);
  return normalized;
}

/**
 * Non-throwing variant for batch normalization.
 *
 * Adapters processing a page of listings use this so one hostile entry is
 * skipped rather than aborting the whole page.
 */
export function tryNormalizePublicResourceUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  try {
    return normalizePublicResourceUrl(input);
  } catch {
    return null;
  }
}
