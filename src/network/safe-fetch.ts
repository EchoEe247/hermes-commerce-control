/**
 * The shared safe HTTP boundary.
 *
 * Every adapter's outbound request goes through here. The guarantees are:
 *
 *  - Scheme, credentials and host are validated before any socket is opened.
 *  - The resolved address is validated *at connection time* via a custom undici
 *    `lookup`. A preflight DNS check alone is defeated by DNS rebinding: a
 *    hostile name can answer with a public address during validation and with
 *    127.0.0.1 when the connection is actually made. Validating inside the
 *    lookup closes that window.
 *  - Redirects are followed manually, at most `maxRedirects` hops, and every hop
 *    is fully revalidated. Automatic redirect following is disabled because it
 *    would bypass the per-hop check.
 *  - Response size is bounded both by a declared Content-Length check and by
 *    counting bytes while streaming, so a lying header cannot exhaust memory.
 *  - No Authorization, Cookie or API-key header is ever attached. This client
 *    has no credential to send, by construction.
 *  - Retries are finite and typed; 4xx other than 429 is never retried.
 */
import { lookup as dnsLookup } from "node:dns";
import { Agent, request as undiciRequest } from "undici";
import type { LookupFunction } from "node:net";
import type { CommerceConfig } from "../config.js";
import { CommerceError } from "../core/errors.js";
import { assertAllowedUrl, assertPublicAddress, isBlockedAddress } from "./ssrf.js";
import { sleep, verdictForNetworkError, verdictForStatus } from "./retry.js";

export interface SafeFetchOptions {
  /**
   * Exact base URLs (scheme + host + port) that are permitted to be local.
   *
   * This exists only for a statically configured local integration endpoint,
   * such as the Data Quality Profiler under test. A marketplace payload can
   * never add to this list: it is set by the caller in code/config, and a URL is
   * matched by exact origin so an allowlisted port does not open its neighbours.
   */
  readonly allowLocalBaseUrls?: readonly string[] | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly budgetMs?: number | undefined;
  readonly userAgent?: string | undefined;
}

export interface SafeResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
  readonly text: string;
}

export interface SafeFetch {
  json<T = unknown>(url: string, init?: RequestInit2): Promise<T>;
  text(url: string, init?: RequestInit2): Promise<SafeResponse>;
}

export interface RequestInit2 {
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly acceptStatuses?: readonly number[] | undefined;
}

/** Header names that must never be attached to an outbound request. */
const FORBIDDEN_REQUEST_HEADERS = /^(authorization|cookie|x-api-key|api-key|x-payment|proxy-authorization)$/i;

const DEFAULT_UA = "hermes-commerce-control/0.1.0 (Mode-A read-only)";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function createSafeFetch(config: CommerceConfig, options: SafeFetchOptions = {}): SafeFetch {
  const maxResponseBytes = options.maxResponseBytes ?? config.network.maxResponseBytes;
  const requestTimeoutMs = options.requestTimeoutMs ?? config.network.requestTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? config.network.connectTimeoutMs;
  const maxRedirects = options.maxRedirects ?? config.network.maxRedirects;
  const maxRetries = options.maxRetries ?? config.network.maxRetries;
  const budgetMs = options.budgetMs ?? config.network.adapterBudgetMs;
  const userAgent = options.userAgent ?? DEFAULT_UA;

  const allowedLocalOrigins = new Set(
    (options.allowLocalBaseUrls ?? [])
      .map(originOf)
      .filter((o): o is string => o !== null),
  );

  /**
   * Connection-time address validation.
   *
   * Runs for every socket. When the target origin is not explicitly
   * allowlisted, any resolved address in a blocked range fails the connection.
   */
  const makeLookup = (allowLocal: boolean): LookupFunction => {
    const fn: LookupFunction = (hostname, opts, callback) => {
      dnsLookup(hostname, opts as never, ((
        err: NodeJS.ErrnoException | null,
        address: unknown,
        family?: unknown,
      ) => {
        if (err !== null) {
          callback(err, "", 0);
          return;
        }
        // undici may request `all`, yielding an array of records.
        if (Array.isArray(address)) {
          const records = address as Array<{ address: string; family: number }>;
          if (!allowLocal) {
            for (const record of records) {
              if (isBlockedAddress(record.address)) {
                callback(
                  new CommerceError(
                    "SSRF_BLOCKED",
                    `connection-time check refused ${hostname} -> ${record.address}`,
                    { hostname, address: record.address },
                  ),
                  "",
                  0,
                );
                return;
              }
            }
          }
          callback(null, records as never, undefined as never);
          return;
        }

        const resolved = String(address);
        if (!allowLocal && isBlockedAddress(resolved)) {
          callback(
            new CommerceError(
              "SSRF_BLOCKED",
              `connection-time check refused ${hostname} -> ${resolved}`,
              { hostname, address: resolved },
            ),
            "",
            0,
          );
          return;
        }
        callback(null, resolved, family as number);
      }) as never);
    };
    return fn;
  };

  const publicAgent = new Agent({
    connect: { timeout: connectTimeoutMs, lookup: makeLookup(false) },
    headersTimeout: requestTimeoutMs,
    bodyTimeout: requestTimeoutMs,
  });
  const localAgent = new Agent({
    connect: { timeout: connectTimeoutMs, lookup: makeLookup(true) },
    headersTimeout: requestTimeoutMs,
    bodyTimeout: requestTimeoutMs,
  });

  /** Validates a URL for this fetcher, honouring the local allowlist. */
  function validate(rawUrl: string): { url: URL; isAllowlistedLocal: boolean } {
    const origin = originOf(rawUrl);
    const isAllowlistedLocal = origin !== null && allowedLocalOrigins.has(origin);

    if (isAllowlistedLocal) {
      // Still refuse a non-HTTP scheme or embedded credentials.
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new CommerceError("SSRF_BLOCKED", `scheme ${url.protocol} is not permitted`);
      }
      if (url.username !== "" || url.password !== "") {
        throw new CommerceError("SSRF_BLOCKED", "URLs carrying embedded credentials are refused");
      }
      return { url, isAllowlistedLocal: true };
    }

    return { url: assertAllowedUrl(rawUrl), isAllowlistedLocal: false };
  }

  function buildHeaders(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      "accept-encoding": "identity",
      "user-agent": userAgent,
    };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (FORBIDDEN_REQUEST_HEADERS.test(key)) {
        throw new CommerceError(
          "SECRET_ACCESS_FORBIDDEN",
          `refusing to send credential header ${JSON.stringify(key)}; this client holds no credentials`,
          { header: key },
        );
      }
      headers[key.toLowerCase()] = value;
    }
    return headers;
  }

  async function once(
    target: string,
    init: RequestInit2,
    deadline: number,
  ): Promise<{ status: number; headers: Record<string, string>; text: string; bytes: number; location: string | null; finalUrl: string }> {
    const { url, isAllowlistedLocal } = validate(target);

    // Defence in depth: if the host is already a literal, check it here too.
    if (!isAllowlistedLocal && url.hostname !== "") {
      const bare = url.hostname.replace(/^\[|\]$/g, "");
      if (/^[0-9a-fA-F:.xX]+$/.test(bare)) assertPublicAddress(bare, "target host");
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CommerceError("UPSTREAM_TIMEOUT", `budget exhausted before requesting ${url.host}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remaining));
    const onOuterAbort = (): void => controller.abort();
    init.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const response = await undiciRequest(url, {
        method: (init.method ?? "GET") as never,
        headers: buildHeaders(init.headers),
        dispatcher: isAllowlistedLocal ? localAgent : publicAgent,
        signal: controller.signal,
        // No maxRedirections is passed: undici does not follow redirects unless
        // a redirect interceptor is configured, and none is. Redirects are
        // handled manually in text() so that every hop is revalidated against
        // the SSRF rules. Automatic following would bypass that check.
      });

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      }

      const declared = headers["content-length"];
      if (declared !== undefined && Number.parseInt(declared, 10) > maxResponseBytes) {
        response.body.destroy();
        throw new CommerceError(
          "RESPONSE_TOO_LARGE",
          `declared content-length ${declared} exceeds cap ${String(maxResponseBytes)}`,
          { host: url.host },
        );
      }

      // Count bytes while streaming so a lying content-length cannot win.
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buf.length;
        if (bytes > maxResponseBytes) {
          response.body.destroy();
          throw new CommerceError(
            "RESPONSE_TOO_LARGE",
            `response body exceeded cap ${String(maxResponseBytes)} bytes`,
            { host: url.host },
          );
        }
        chunks.push(buf);
      }

      return {
        status: response.statusCode,
        headers,
        text: Buffer.concat(chunks).toString("utf8"),
        bytes,
        location: headers.location ?? null,
        finalUrl: url.toString(),
      };
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout|timed out/i.test(message)) {
        throw new CommerceError("UPSTREAM_TIMEOUT", `request to ${url.host} timed out`, {
          host: url.host,
        });
      }
      throw new CommerceError("UPSTREAM_UNAVAILABLE", `request to ${url.host} failed: ${message}`, {
        host: url.host,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async function text(rawUrl: string, init: RequestInit2 = {}): Promise<SafeResponse> {
    const started = Date.now();
    const deadline = started + budgetMs;
    const accept = new Set(init.acceptStatuses ?? []);

    let current = rawUrl;
    let attempt = 0;
    let hops = 0;

    for (;;) {
      let result: Awaited<ReturnType<typeof once>>;
      try {
        result = await once(current, init, deadline);
      } catch (error) {
        // SSRF and size failures are terminal, never retried.
        if (
          error instanceof CommerceError &&
          (error.code === "SSRF_BLOCKED" ||
            error.code === "RESPONSE_TOO_LARGE" ||
            error.code === "INVALID_URL" ||
            error.code === "SECRET_ACCESS_FORBIDDEN" ||
            error.code === "TOO_MANY_REDIRECTS")
        ) {
          throw error;
        }
        const verdict = verdictForNetworkError(attempt, { maxRetries, budgetMs }, Date.now() - started);
        if (!verdict.retry) throw error;
        attempt += 1;
        await sleep(verdict.delayMs, init.signal);
        continue;
      }

      // Redirects: revalidate every hop.
      if (result.status >= 300 && result.status < 400 && result.location !== null) {
        hops += 1;
        if (hops > maxRedirects) {
          throw new CommerceError(
            "TOO_MANY_REDIRECTS",
            `exceeded ${String(maxRedirects)} redirects starting at ${rawUrl}`,
          );
        }
        const next = new URL(result.location, result.finalUrl).toString();
        // validate() runs again on the next iteration; do it now so a blocked
        // target is reported as SSRF_BLOCKED rather than as a generic failure.
        validate(next);
        current = next;
        continue;
      }

      if (result.status >= 200 && result.status < 300) {
        return Object.freeze({
          status: result.status,
          url: result.finalUrl,
          headers: Object.freeze(result.headers),
          bytes: result.bytes,
          text: result.text,
        });
      }

      if (accept.has(result.status)) {
        return Object.freeze({
          status: result.status,
          url: result.finalUrl,
          headers: Object.freeze(result.headers),
          bytes: result.bytes,
          text: result.text,
        });
      }

      const verdict = verdictForStatus(
        result.status,
        attempt,
        { maxRetries, budgetMs },
        result.headers["retry-after"] ?? null,
        Date.now() - started,
      );
      if (verdict.retry) {
        attempt += 1;
        await sleep(verdict.delayMs, init.signal);
        continue;
      }

      if (result.status === 429) {
        throw new CommerceError("UPSTREAM_RATE_LIMITED", `rate limited by ${result.finalUrl}`, {
          status: result.status,
        });
      }
      throw new CommerceError(
        "UPSTREAM_UNAVAILABLE",
        `HTTP ${String(result.status)} from ${result.finalUrl}`,
        { status: result.status },
      );
    }
  }

  async function json<T = unknown>(rawUrl: string, init: RequestInit2 = {}): Promise<T> {
    const response = await text(rawUrl, init);
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new CommerceError(
        "UPSTREAM_MALFORMED",
        `response from ${response.url} was not valid JSON`,
        { url: response.url },
      );
    }
  }

  return { json, text };
}
