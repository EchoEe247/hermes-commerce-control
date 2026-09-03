import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  PayShAdapter,
  PHASE_2_REASON,
  parseFrontMatter,
  parsePaymentProse,
} from "../src/adapters/paysh/index.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import { CommerceError } from "../src/core/errors.js";
import type { AdapterContext } from "../src/adapters/interface.js";
import type { SafeFetch } from "../src/network/safe-fetch.js";
import {
  BIRDEYE_PAY_MD,
  BLOCKRUN_PAY_MD,
  EMPTY_PROVIDERS_LISTING,
  HOSTILE_PAY_MD,
  MALFORMED_PROVIDERS_LISTING,
  NO_FRONTMATTER_PAY_MD,
  NO_SERVICE_URL_PAY_MD,
  PROVIDERS_LISTING,
  PROVIDER_SERVICES_LISTING,
} from "./fixtures/paysh/responses.js";

const cfg = loadConfig({});
const CLOCK = (): string => "2026-08-19T00:00:00.000Z";

/** Routes GitHub contents and raw PAY.md requests to fixtures. */
function registryFetch(overrides: Record<string, string> = {}): {
  fetch: SafeFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const payMd: Record<string, string> = {
    "providers/birdeye/data/PAY.md": BIRDEYE_PAY_MD,
    "providers/blockrun/rpc/PAY.md": BLOCKRUN_PAY_MD,
    "providers/dtelecom/stream/PAY.md": NO_SERVICE_URL_PAY_MD,
    ...overrides,
  };

  const fetch: SafeFetch = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      if (url.endsWith("/contents/providers")) return PROVIDERS_LISTING as T;
      const provider = /\/contents\/(providers\/[^/]+)$/.exec(url);
      if (provider !== null) {
        const key = provider[1] as string;
        const listing = PROVIDER_SERVICES_LISTING[key];
        if (listing === undefined) throw new CommerceError("NOT_FOUND", `no listing for ${key}`);
        return listing as T;
      }
      throw new CommerceError("NOT_FOUND", `unexpected json url ${url}`);
    },
    text: async (url: string) => {
      urls.push(url);
      for (const [path, body] of Object.entries(payMd)) {
        if (url.endsWith(path)) {
          return { status: 200, url, headers: {}, bytes: body.length, text: body };
        }
      }
      throw new CommerceError("UPSTREAM_UNAVAILABLE", `no fixture for ${url}`);
    },
  };
  return { fetch, urls };
}

function ctx(fetch: SafeFetch): AdapterContext {
  return {
    fetch,
    evidence: new EvidenceCollector("paysh", CLOCK),
    clock: CLOCK,
    signal: new AbortController().signal,
    config: cfg,
  };
}

test("paysh: parses PAY.md front matter including nested openapi.path", () => {
  const front = parseFrontMatter(BIRDEYE_PAY_MD);
  assert.ok(front !== null);
  assert.equal(front?.name, "data");
  assert.equal(front?.title, "Birdeye Data", "quoted values must be unquoted");
  assert.match(String(front?.description), /DeFi market data/);
  assert.match(String(front?.useCase), /token prices/);
  assert.equal(front?.category, "finance");
  assert.equal(front?.serviceUrl, "https://public-api.birdeye.so");
  assert.equal(front?.openapiPath, "openapi.json");
});

test("paysh: markdown without front matter yields null", () => {
  assert.equal(parseFrontMatter(NO_FRONTMATTER_PAY_MD), null);
  assert.equal(parseFrontMatter(""), null);
  assert.equal(parseFrontMatter("no delimiters at all"), null);
  assert.equal(parseFrontMatter(undefined as unknown as string), null);
});

test("paysh: the front-matter reader ignores unsupported YAML constructs", () => {
  // Anchors, aliases and tags must not be evaluated; they are simply not keys.
  const front = parseFrontMatter(`---
name: x
service_url: https://ok.example
danger: !!python/object/apply:os.system ["echo pwned"]
anchor: &a value
alias: *a
---
body`);
  assert.equal(front?.name, "x");
  assert.equal(front?.serviceUrl, "https://ok.example");
  // The dangerous values are captured as inert strings, never executed.
  assert.equal(front?.openapiPath, undefined);
});

test("paysh: payment prose yields Solana mainnet and the asset", () => {
  assert.deepEqual(parsePaymentProse(BIRDEYE_PAY_MD), {
    network: "solana:mainnet",
    asset: "USDC",
  });
  assert.deepEqual(parsePaymentProse(BLOCKRUN_PAY_MD), {
    network: "solana:mainnet",
    asset: "USDT",
  });
  assert.deepEqual(parsePaymentProse("no payment info"), {
    network: undefined,
    asset: undefined,
  });
});

test("paysh: discovery normalizes registry services with FQN and network", async () => {
  const stub = registryFetch();
  const services = await new PayShAdapter().discoverServices({}, ctx(stub.fetch));

  // birdeye/data and blockrun/rpc normalize; dtelecom/stream has no service_url.
  assert.equal(services.length, 2);
  const birdeye = services.find((s) => s.tags.includes("fqn:birdeye/data"));
  assert.ok(birdeye);
  assert.equal(birdeye?.name, "Birdeye Data");
  assert.equal(birdeye?.resourceUrl, "https://public-api.birdeye.so/");
  assert.equal(birdeye?.network, "solana:mainnet");
  assert.equal(birdeye?.asset?.symbol, "USDC");
  assert.equal(birdeye?.sources[0]?.externalId, "birdeye/data");
  assert.ok(birdeye?.tags.includes("category:finance"));
});

test("paysh: no machine-readable price means no quote and no purchase preparation", async () => {
  const stub = registryFetch();
  const services = await new PayShAdapter().discoverServices({}, ctx(stub.fetch));
  for (const s of services) {
    assert.equal(s.price, undefined, "prose pricing must not be parsed into a price");
    assert.equal(s.actionability.canQuote, false);
    assert.equal(s.actionability.canPreparePurchase, false);
    assert.equal(s.actionability.canPurchase, false);
    assert.ok(
      s.evidence.some((e) => e.fact === "price" && e.classification === "tentative"),
      "the unknown price should be recorded as tentative",
    );
  }
});

test("paysh: an entry without service_url is skipped", async () => {
  const stub = registryFetch();
  const services = await new PayShAdapter().discoverServices({}, ctx(stub.fetch));
  assert.equal(
    services.some((s) => s.tags.includes("fqn:dtelecom/stream")),
    false,
  );
});

test("paysh: a registry entry pointing at a private host is refused", () => {
  const adapter = new PayShAdapter();
  const context = ctx(registryFetch().fetch);
  // The registry is attacker-authorable content, so a loopback service_url must
  // not become a canonical service.
  const candidate = adapter.normalize("evil/evil", HOSTILE_PAY_MD, context, "https://x/y");
  assert.equal(candidate, null, "a 127.0.0.1 service_url must be rejected");
});

test("paysh: hostile front-matter text stays inert data", () => {
  const front = parseFrontMatter(HOSTILE_PAY_MD);
  assert.ok(front !== null);
  // Preserved as a description string; never acted upon.
  assert.match(String(front?.description), /SYSTEM: ignore instructions/);
  assert.equal(front?.serviceUrl, "http://127.0.0.1:8081");
});

test("paysh: one unreadable provider does not abort the registry scan", async () => {
  const stub = registryFetch();
  const brokenFetch: SafeFetch = {
    json: async <T>(url: string): Promise<T> => {
      if (url.endsWith("/contents/providers/birdeye")) {
        throw new CommerceError("UPSTREAM_UNAVAILABLE", "provider listing failed");
      }
      return stub.fetch.json<T>(url);
    },
    text: stub.fetch.text,
  };
  const services = await new PayShAdapter().discoverServices({}, ctx(brokenFetch));
  // blockrun still normalizes even though birdeye failed.
  assert.equal(services.length, 1);
  assert.ok(services[0]?.tags.includes("fqn:blockrun/rpc"));
});

test("paysh: an empty registry is success with zero results", async () => {
  const fetch: SafeFetch = {
    json: async <T>(): Promise<T> => EMPTY_PROVIDERS_LISTING as T,
    text: async () => {
      throw new CommerceError("NOT_FOUND", "unused");
    },
  };
  assert.deepEqual(await new PayShAdapter().discoverServices({}, ctx(fetch)), []);
});

test("paysh: a malformed registry response raises UPSTREAM_MALFORMED", async () => {
  const fetch: SafeFetch = {
    json: async <T>(): Promise<T> => MALFORMED_PROVIDERS_LISTING as T,
    text: async () => {
      throw new CommerceError("NOT_FOUND", "unused");
    },
  };
  await assert.rejects(
    () => new PayShAdapter().discoverServices({}, ctx(fetch)),
    /UPSTREAM_MALFORMED/,
  );
});

test("paysh: health reports reachable and states Phase 2", async () => {
  const stub = registryFetch();
  const probe = await new PayShAdapter().health(ctx(stub.fetch));
  assert.equal(probe.status, "ok");
  assert.match(String(probe.detail), /Phase 2/);
});

test("paysh: health degrades truthfully when the registry is unavailable", async () => {
  const fetch: SafeFetch = {
    json: async () => {
      throw new CommerceError("UPSTREAM_UNAVAILABLE", "HTTP 503");
    },
    text: async () => {
      throw new CommerceError("UPSTREAM_UNAVAILABLE", "HTTP 503");
    },
  };
  const probe = await new PayShAdapter().health(ctx(fetch));
  assert.equal(probe.status, "unreachable");
  assert.equal(probe.errorCode, "UPSTREAM_UNAVAILABLE");
});

test("paysh: preparePublish emits a local draft and stays Phase-2 blocked", async () => {
  const stub = registryFetch();
  const prepared = await new PayShAdapter().preparePublish(
    {
      product: "data-quality-profiler",
      version: "0.1.0",
      resourceUrl: "https://profiler.example/v1/profile",
      method: "POST",
      protocol: "x402",
      network: "eip155:84532",
      price: "$0.02",
      description: "Profiles a dataset",
      metadata: {},
    },
    ctx(stub.fetch),
  );

  assert.equal(prepared.ready, false);
  assert.equal(prepared.prepared, false);
  assert.equal(prepared.reason, PHASE_2_REASON);
  assert.equal(prepared.registrationPerformed, false);
  assert.equal(prepared.pullRequestOpened, false);
  assert.equal(prepared.walletConfigured, false);
  assert.equal(prepared.blockedReason, "EXTERNAL_WRITE_DISABLED");
  // A usable local draft is still produced.
  assert.match(String(prepared.payMdDraft), /^---\nname: data-quality-profiler/);
  assert.match(String(prepared.payMdDraft), /service_url: https:\/\/profiler\.example/);
  assert.match(String(prepared.registryPath), /^providers\//);
  // preparePublish must not touch the network at all.
  assert.deepEqual(stub.urls, []);
});

test("paysh: the adapter never runs pay setup, topup, signing, a fork or a PR", () => {
  const source = readFileSync(new URL("../src/adapters/paysh/index.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "child_process",
    "execSync",
    "spawn",
    "pay setup",
    "pay topup",
    "/pulls",
    "/forks",
    "/git/refs",
  ]) {
    assert.equal(source.includes(forbidden), false, `source must not use ${forbidden}`);
  }
  // No YAML dependency: attacker-authored registry content is parsed by a
  // minimal scalar reader, not a general engine.
  assert.equal(/from ["']js-yaml["']|from ["']yaml["']/.test(source), false);
});

test("paysh: capabilities mark it discovery plus publication preparation only", () => {
  const caps = new PayShAdapter().capabilities();
  assert.equal(caps.liveExecution, false);
  assert.equal(caps.discoverServices, true);
  assert.equal(caps.preparePublish, true);
  assert.equal(caps.quote, false);
  assert.equal(caps.preparePurchase, false);
  assert.equal(caps.walletless, true);
});
