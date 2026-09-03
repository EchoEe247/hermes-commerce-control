/**
 * Bounded retry policy.
 *
 * Every bound is finite and small. There is no exponential backoff that can
 * grow without limit, no jitter loop that can spin, and no retry on a 4xx other
 * than 429 (retrying a 400 or 403 only produces load, never a different answer).
 */
import { CommerceError } from "../core/errors.js";

export interface RetryBounds {
  readonly maxRetries: number;
  /** Wall-clock ceiling for the whole operation, including waits. */
  readonly budgetMs: number;
}

export type RetryVerdict =
  | { readonly retry: false }
  | { readonly retry: true; readonly delayMs: number };

/** Decides whether an HTTP status is retryable, and after how long. */
export function verdictForStatus(
  status: number,
  attempt: number,
  bounds: RetryBounds,
  retryAfterHeader: string | null,
  elapsedMs: number,
): RetryVerdict {
  if (attempt >= bounds.maxRetries) return { retry: false };

  if (status === 429) {
    const delayMs = parseRetryAfter(retryAfterHeader, 1_000);
    // Honour Retry-After only if the wait still fits inside the budget.
    if (elapsedMs + delayMs > bounds.budgetMs) return { retry: false };
    return { retry: true, delayMs };
  }

  if (status >= 500 && status <= 599) {
    const delayMs = backoffMs(attempt);
    if (elapsedMs + delayMs > bounds.budgetMs) return { retry: false };
    return { retry: true, delayMs };
  }

  // All other 4xx and every 2xx/3xx: no automatic retry.
  return { retry: false };
}

/** Decides whether a transport-level failure is retryable. */
export function verdictForNetworkError(
  attempt: number,
  bounds: RetryBounds,
  elapsedMs: number,
): RetryVerdict {
  if (attempt >= bounds.maxRetries) return { retry: false };
  const delayMs = backoffMs(attempt);
  if (elapsedMs + delayMs > bounds.budgetMs) return { retry: false };
  return { retry: true, delayMs };
}

/** Fixed, small backoff schedule. Capped so it can never dominate the budget. */
export function backoffMs(attempt: number): number {
  const schedule = [250, 750, 1_500];
  return schedule[Math.min(attempt, schedule.length - 1)] ?? 1_500;
}

/**
 * Parses Retry-After, accepting both the delta-seconds and HTTP-date forms.
 * Clamped to 30s so a hostile header cannot stall the process.
 */
export function parseRetryAfter(header: string | null, fallbackMs: number): number {
  if (header === null || header.trim() === "") return fallbackMs;
  const raw = header.trim();

  if (/^\d+$/.test(raw)) {
    return Math.min(30_000, Number.parseInt(raw, 10) * 1_000);
  }

  const when = Date.parse(raw);
  if (!Number.isNaN(when)) {
    return Math.min(30_000, Math.max(0, when - Date.now()));
  }
  return fallbackMs;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new CommerceError("UPSTREAM_TIMEOUT", "aborted while waiting to retry"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted === true) {
      cleanup();
      reject(new CommerceError("UPSTREAM_TIMEOUT", "aborted before retry wait"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
