import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createSafeFetch } from "../src/network/safe-fetch.js";
import { loadConfig } from "../src/config.js";
import { parseRetryAfter, verdictForStatus, backoffMs } from "../src/network/retry.js";

const cfg = loadConfig({});

/**
 * A loopback test server. Requests to it must be refused by the *public* safe
 * fetch, so it is only reachable through the explicitly-allowlisted variant
 * used for local integration endpoints.
 */
async function withServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("safe-fetch: refuses a loopback URL even when a server is listening", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg);
      await assert.rejects(() => safeFetch.json(base + "/x"), /SSRF_BLOCKED/);
    },
  );
});

test("safe-fetch: allowlisted local base URL is permitted for local integration", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      const body = await safeFetch.json<{ ok: boolean }>(base + "/x");
      assert.equal(body.ok, true);
    },
  );
});

test("safe-fetch: an allowlisted base does not allow a sibling local port", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (base) => {
      const other = base.replace(/:(\d+)$/, (_m, p) => `:${Number(p) + 1}`);
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      await assert.rejects(() => safeFetch.json(other + "/x"), /SSRF_BLOCKED/);
    },
  );
});

test("safe-fetch: a redirect to a private address is refused", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("{}");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      await assert.rejects(() => safeFetch.json(base + "/start"), /SSRF_BLOCKED/);
    },
  );
});

test("safe-fetch: a redirect loop is bounded by maxRedirects", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      await assert.rejects(() => safeFetch.json(base + "/loop"), /TOO_MANY_REDIRECTS/);
    },
  );
});

test("safe-fetch: an oversized response is refused", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Stream more than the configured cap without declaring content-length.
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 40; i += 1) res.write(chunk);
      res.end();
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, {
        allowLocalBaseUrls: [base],
        maxResponseBytes: 128 * 1024,
      });
      await assert.rejects(() => safeFetch.json(base + "/big"), /RESPONSE_TOO_LARGE/);
    },
  );
});

test("safe-fetch: a declared oversized content-length is refused before reading", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "99999999" });
      res.end("{}");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, {
        allowLocalBaseUrls: [base],
        maxResponseBytes: 1024,
      });
      await assert.rejects(() => safeFetch.json(base + "/big"), /RESPONSE_TOO_LARGE/);
    },
  );
});

test("safe-fetch: malformed JSON becomes UPSTREAM_MALFORMED", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json at all");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      await assert.rejects(() => safeFetch.json(base + "/bad"), /UPSTREAM_MALFORMED/);
    },
  );
});

test("safe-fetch: a 429 without budget becomes UPSTREAM_RATE_LIMITED", async () => {
  let hits = 0;
  await withServer(
    (_req, res) => {
      hits += 1;
      res.writeHead(429, { "retry-after": "120" });
      res.end("slow down");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, {
        allowLocalBaseUrls: [base],
        maxRetries: 2,
        budgetMs: 2_000,
      });
      await assert.rejects(() => safeFetch.json(base + "/rl"), /UPSTREAM_RATE_LIMITED/);
      // Retry-After of 120s exceeds the budget, so it must not have been slept.
      assert.equal(hits, 1, "must not retry when Retry-After exceeds the budget");
    },
  );
});

test("safe-fetch: a 5xx is retried at most maxRetries times then reported", async () => {
  let hits = 0;
  await withServer(
    (_req, res) => {
      hits += 1;
      res.writeHead(503);
      res.end("nope");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, {
        allowLocalBaseUrls: [base],
        maxRetries: 2,
        budgetMs: 20_000,
      });
      await assert.rejects(() => safeFetch.json(base + "/err"), /UPSTREAM_UNAVAILABLE/);
      assert.equal(hits, 3, "one initial attempt plus two retries");
    },
  );
});

test("safe-fetch: a 4xx other than 429 is not retried", async () => {
  let hits = 0;
  await withServer(
    (_req, res) => {
      hits += 1;
      res.writeHead(403);
      res.end("denied");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base], maxRetries: 2 });
      await assert.rejects(() => safeFetch.json(base + "/denied"), /UPSTREAM_UNAVAILABLE/);
      assert.equal(hits, 1, "4xx must not be retried");
    },
  );
});

test("safe-fetch: a slow response times out", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Never finish.
      res.write("{");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, {
        allowLocalBaseUrls: [base],
        requestTimeoutMs: 300,
        maxRetries: 0,
      });
      await assert.rejects(() => safeFetch.json(base + "/slow"), /UPSTREAM_TIMEOUT/);
    },
  );
});

test("safe-fetch: no Authorization header is ever sent", async () => {
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  await withServer(
    (req, res) => {
      seen.push({ ...req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
    async (base) => {
      const safeFetch = createSafeFetch(cfg, { allowLocalBaseUrls: [base] });
      await safeFetch.json(base + "/x");
      assert.equal(seen.length, 1);
      const headers = seen[0] ?? {};
      for (const key of Object.keys(headers)) {
        assert.equal(
          /^(authorization|cookie|x-api-key)$/i.test(key),
          false,
          `unexpected credential header sent: ${key}`,
        );
      }
    },
  );
});

test("safe-fetch: non-http schemes never reach the transport", async () => {
  const safeFetch = createSafeFetch(cfg);
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi"]) {
    await assert.rejects(() => safeFetch.json(url), /SSRF_BLOCKED|INVALID_URL/, url);
  }
});

test("retry: parseRetryAfter handles seconds and HTTP-date and clamps", () => {
  assert.equal(parseRetryAfter("5", 1000), 5000);
  assert.equal(parseRetryAfter("9999", 1000), 30_000);
  assert.equal(parseRetryAfter(null, 1234), 1234);
  assert.equal(parseRetryAfter("garbage", 777), 777);
  const future = new Date(Date.now() + 2000).toUTCString();
  const parsed = parseRetryAfter(future, 0);
  assert.ok(parsed > 0 && parsed <= 30_000);
});

test("retry: 4xx is not retryable, 429 and 5xx are within budget", () => {
  const bounds = { maxRetries: 2, budgetMs: 30_000 };
  assert.equal(verdictForStatus(400, 0, bounds, null, 0).retry, false);
  assert.equal(verdictForStatus(403, 0, bounds, null, 0).retry, false);
  assert.equal(verdictForStatus(404, 0, bounds, null, 0).retry, false);
  assert.equal(verdictForStatus(429, 0, bounds, "1", 0).retry, true);
  assert.equal(verdictForStatus(503, 0, bounds, null, 0).retry, true);
  // Exhausted attempts.
  assert.equal(verdictForStatus(503, 2, bounds, null, 0).retry, false);
  // Budget nearly gone.
  assert.equal(verdictForStatus(503, 0, bounds, null, 29_900).retry, false);
  assert.ok(backoffMs(0) <= backoffMs(2));
});
