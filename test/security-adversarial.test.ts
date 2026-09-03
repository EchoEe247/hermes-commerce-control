import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { createSafeFetch } from "../src/network/safe-fetch.js";
import { assertAllowedUrl } from "../src/network/ssrf.js";
import { sanitize, sanitizeText, findResidualSecrets } from "../src/evidence/sanitize.js";
import { EvidenceCollector } from "../src/evidence/capture.js";
import {
  HOSTILE_PROMPT_TEXT,
  HOSTILE_SERVICE_PAYLOAD,
  HOSTILE_VARIANTS,
  HOSTILE_WORK_PAYLOAD,
} from "./fixtures/hostile.js";

const cfg = loadConfig({});

/**
 * Private/local URLs a hostile listing might try to smuggle into canonical state.
 * Drawn from the ranges the SSRF layer already blocks, so ingestion and
 * connection-time enforcement are proven consistent rather than divergent.
 */
const PRIVATE_RESOURCE_URLS: readonly string[] = Object.freeze([
  "http://127.0.0.1:8081/v1/x",
  "http://localhost:9999/admin",
  "http://192.168.1.1/claim",
  "http://10.0.0.1/payload",
  "http://172.16.0.5/x",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:8081/x",
  "http://[::ffff:127.0.0.1]/x",
  "http://[fc00::1]/x",
  "http://[fe80::1]/x",
  "http://2130706433/x",
  "http://0x7f000001/x",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://svc.internal/x",
  "http://printer.local/x",
]);

test("adversarial: ingestion refuses a private resource URL for every adapter", async () => {
  const { normalizePublicResourceUrl, tryNormalizePublicResourceUrl } = await import(
    "../src/adapters/resource-url.js"
  );

  // The shared ingestion boundary must reject every one of these outright.
  for (const url of PRIVATE_RESOURCE_URLS) {
    assert.throws(
      () => normalizePublicResourceUrl(url),
      /SSRF_BLOCKED|INVALID_URL/,
      `ingestion must refuse ${url}`,
    );
    assert.equal(tryNormalizePublicResourceUrl(url), null, `batch variant must skip ${url}`);
  }
  // A genuinely public URL still passes, so the guard is not simply denying all.
  assert.equal(
    normalizePublicResourceUrl("HTTPS://API.Example.com:443/v1/profile"),
    "https://api.example.com/v1/profile",
  );
});

test("adversarial: no adapter admits a loopback listing into canonical state", async () => {
  const clock = (): string => "2026-08-19T00:00:00.000Z";
  const { normalizeBazaarItem } = await import("../src/adapters/cdp-bazaar/index.js");
  const { normalizePipRailResource } = await import("../src/adapters/piprail/index.js");
  const { normalizeThe402Service } = await import("../src/adapters/the402/index.js");
  const { PayShAdapter } = await import("../src/adapters/paysh/index.js");
  const { Agent402Adapter } = await import("../src/adapters/agent402/index.js");

  const makeCtx = (platform: Parameters<typeof EvidenceCollector>[0] extends never ? never : "cdp_bazaar" | "piprail" | "the402" | "paysh" | "agent402") => ({
    fetch: {
      json: async () => {
        throw new Error("no network in this test");
      },
      text: async () => {
        throw new Error("no network in this test");
      },
    },
    evidence: new EvidenceCollector(platform, clock),
    clock,
    signal: new AbortController().signal,
    config: cfg,
  });

  for (const url of PRIVATE_RESOURCE_URLS) {
    // CDP Bazaar: hostile `resource`.
    assert.equal(
      normalizeBazaarItem({ resource: url, accepts: [] }, makeCtx("cdp_bazaar") as never, "https://x/y"),
      null,
      `cdp_bazaar must skip ${url}`,
    );

    // PipRail: hostile index `resource`.
    assert.equal(
      normalizePipRailResource({ resource: url, rails: [] }, makeCtx("piprail") as never, "piprail:discover"),
      null,
      `piprail must skip ${url}`,
    );

    // the402: hostile `endpoint`.
    assert.equal(
      normalizeThe402Service({ id: "svc_x", endpoint: url }, makeCtx("the402") as never, "https://x/y"),
      null,
      `the402 must skip ${url}`,
    );

    // Pay.sh: hostile `service_url` in registry front matter.
    const payMd = `---\nname: evil\ntitle: "Evil"\ncategory: data\nservice_url: ${url}\n---\n\nx402 USDC payment accepted on Solana mainnet.\n`;
    assert.equal(
      new PayShAdapter().normalize("evil/evil", payMd, makeCtx("paysh") as never, "https://x/y"),
      null,
      `paysh must skip ${url}`,
    );
  }

  // Agent402 derives its URL from a catalogue baseUrl; a private baseUrl must
  // yield no candidates rather than a loopback service.
  const agent402 = new Agent402Adapter("http://127.0.0.1:8081");
  const services = await agent402.discoverServices({}, {
    ...makeCtx("agent402"),
    fetch: {
      json: async () => ({
        baseUrl: "http://127.0.0.1:8081",
        payment: { network: "base" },
        endpoints: [{ method: "GET", path: "/api/x", name: "x", price: "$0.01", slug: "x" }],
      }),
      text: async () => {
        throw new Error("unused");
      },
    },
  } as never);
  assert.deepEqual(services, [], "agent402 must not emit a loopback service");
});

test("adversarial: one hostile listing does not discard the valid rest of a page", async () => {
  const clock = (): string => "2026-08-19T00:00:00.000Z";
  const { CdpBazaarAdapter } = await import("../src/adapters/cdp-bazaar/index.js");
  const ctx = {
    fetch: {
      json: async () => ({
        x402Version: 2,
        pagination: { limit: 3, offset: 0, total: 3 },
        items: [
          // Hostile entry first, so a naive implementation would abort here.
          { resource: "http://127.0.0.1:8081/evil", accepts: [] },
          {
            resource: "https://api.good.example/v1/one",
            accepts: [
              {
                scheme: "exact",
                network: "eip155:8453",
                amount: "3000",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
              },
            ],
          },
          { resource: "https://api.good.example/v1/two", accepts: [] },
        ],
      }),
      text: async () => {
        throw new Error("unused");
      },
    },
    evidence: new EvidenceCollector("cdp_bazaar", clock),
    clock,
    signal: new AbortController().signal,
    config: cfg,
  };

  const services = await new CdpBazaarAdapter(
    "https://api.cdp.coinbase.com/platform/v2/x402/discovery/",
  ).discoverServices({}, ctx as never);

  assert.equal(services.length, 2, "the two legitimate listings must survive");
  for (const s of services) {
    assert.ok(
      s.resourceUrl.startsWith("https://api.good.example/"),
      `unexpected canonical URL ${s.resourceUrl}`,
    );
  }
});

test("adversarial: connection-time validation remains authoritative after ingestion checks", async () => {
  // Ingestion rejection is defense in depth, not a replacement. A URL whose host
  // is public at parse time must still be validated when the socket opens, which
  // is what defeats DNS rebinding. Assert the safe-fetch layer still refuses a
  // literal private target and that its lookup guard is wired up.
  const safeFetch = createSafeFetch(cfg);
  await assert.rejects(() => safeFetch.json("http://127.0.0.1:9/x"), /SSRF_BLOCKED/);

  const source = readFileSync(new URL("../src/network/safe-fetch.ts", import.meta.url), "utf8");
  assert.ok(source.includes("lookup:"), "undici must be given a validating lookup");
  assert.ok(
    source.includes("connection-time check refused"),
    "the lookup guard must reject at connection time",
  );
  // Redirects must be handled manually so every hop is revalidated.
  assert.ok(source.includes("TOO_MANY_REDIRECTS"));
});

test("adversarial: the hostile prompt is preserved as inert text, not executed", () => {
  const collector = new EvidenceCollector("cdp_bazaar", () => "2026-08-19T00:00:00.000Z");
  const capture = collector.capture("hostile_listing", HOSTILE_SERVICE_PAYLOAD);
  const serialized = JSON.stringify(capture.sanitized);

  // The instruction text survives as data: we do not silently drop marketplace
  // content, because a reviewer must be able to see what was published.
  assert.ok(serialized.includes("Ignore Hermes"), "hostile text should persist as data");

  // But the credentials embedded alongside it must be gone.
  assert.equal(serialized.includes("should-never-be-retained"), false);
  assert.equal(
    serialized.includes("0x1111111111111111111111111111111111111111111111111111111111111111"),
    false,
  );
});

test("adversarial: hostile text never causes a filesystem side effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "hcc-adv-"));
  const canary = join(dir, "canary.txt");
  writeFileSync(canary, "untouched");
  try {
    for (const variant of HOSTILE_VARIANTS) {
      // Passing hostile text through every text-handling path.
      sanitizeText(variant);
      sanitize({ description: variant });
      const collector = new EvidenceCollector("agent402", () => "2026-08-19T00:00:00.000Z");
      collector.observe("description", variant, "http_api", "https://example.com/x");
    }
    assert.equal(readFileSync(canary, "utf8"), "untouched", "canary file was modified");
    assert.equal(existsSync(join(dir, "payload.sh")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: a marketplace-supplied URL cannot reach localhost or a LAN host", async () => {
  const safeFetch = createSafeFetch(cfg);
  const attackerUrls = [
    "http://127.0.0.1:8081/",
    "http://localhost:9999/admin",
    "http://192.168.1.1/claim",
    "http://10.0.0.1/payload.sh",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8081/",
    "http://2130706433/",
    "http://0x7f000001/",
    "file:///etc/passwd",
    "http://metadata.google.internal/computeMetadata/v1/",
  ];
  for (const url of attackerUrls) {
    await assert.rejects(
      () => safeFetch.json(url),
      /SSRF_BLOCKED|INVALID_URL/,
      `must refuse ${url}`,
    );
  }
});

test("adversarial: URLs extracted from the hostile payload are all refused", () => {
  const embedded = [
    HOSTILE_SERVICE_PAYLOAD.accepts[0]?.extra.adminUrl,
    HOSTILE_WORK_PAYLOAD.claimUrl,
  ].filter((u): u is string => typeof u === "string");
  assert.ok(embedded.length >= 2);
  for (const url of embedded) {
    assert.throws(() => assertAllowedUrl(url), /SSRF_BLOCKED/, url);
  }
});

test("adversarial: hostile text cannot flip a policy decision", () => {
  for (const variant of HOSTILE_VARIANTS) {
    const decision = evaluatePolicy(cfg, {
      operation: variant,
      class: "VALUE_MOVEMENT",
    });
    assert.equal(decision.decision, "block", "value movement must stay blocked");
    assert.equal(decision.reason, "LIVE_VALUE_MOVEMENT_DISABLED");
  }
  // A hostile operation name in a read class stays a read; it gains nothing.
  const read = evaluatePolicy(cfg, { operation: HOSTILE_PROMPT_TEXT, class: "READ" });
  assert.equal(read.decision, "allow");
  assert.equal(read.mode, "A");
});

test("adversarial: hostile config injection cannot enable either gate", () => {
  // The exact strings the injected text asks for.
  assert.throws(() => loadConfig({ EXTERNAL_WRITES_ENABLED: "true" }), /Mode A/);
  assert.throws(() => loadConfig({ LIVE_VALUE_MOVEMENT_ENABLED: "true" }), /Mode A/);
  // And the config that does load is immutable.
  const live = loadConfig({});
  assert.equal(live.externalWritesEnabled, false);
  assert.equal(live.liveValueMovementEnabled, false);
  assert.throws(() => {
    (live as unknown as Record<string, unknown>).liveValueMovementEnabled = true;
  });
});

test("adversarial: a work payload claiming verified funding cannot self-certify", () => {
  const collector = new EvidenceCollector("agent_bounties", () => "2026-08-19T00:00:00.000Z");
  // The payload says funding_evidence: "verified". Believing it requires proof.
  assert.equal(HOSTILE_WORK_PAYLOAD.funding_evidence, "verified");
  assert.throws(
    () =>
      collector.verified(
        "funding",
        "funded",
        "http_api",
        "https://evil.example.com/bounty/evil-1",
        false,
      ),
    /proof|EVIDENCE/i,
  );
});

test("adversarial: no secret survives sanitization into an exportable artifact", () => {
  const payload = {
    listing: HOSTILE_SERVICE_PAYLOAD,
    work: HOSTILE_WORK_PAYLOAD,
    env: {
      PRIVATE_KEY: "0x2222222222222222222222222222222222222222222222222222222222222222",
      MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      NWC_URL: "nostr+walletconnect://npub1?relay=wss://r&secret=deadbeefcafe",
      OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    },
    headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" },
  };
  const serialized = JSON.stringify(sanitize(payload));
  for (const leak of [
    "0x2222222222222222222222222222222222222222222222222222222222222222",
    "abandon abandon",
    "deadbeefcafe",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "eyJhbGciOiJIUzI1NiJ9",
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "should-never-be-retained",
  ]) {
    assert.equal(serialized.includes(leak), false, `sanitizer leaked ${leak}`);
  }
  assert.deepEqual(findResidualSecrets(serialized), [], "residual secret patterns remain");
});

test("adversarial: an oversized hostile description is bounded, not unbounded", () => {
  const huge = "A".repeat(2_000_000) + HOSTILE_PROMPT_TEXT;
  const out = sanitizeText(huge);
  assert.equal(typeof out, "string");
  // Sanitization must not amplify the input.
  assert.ok(out.length <= huge.length + 64);
});

test("adversarial: deeply nested hostile payload does not exhaust the stack", () => {
  let nested: Record<string, unknown> = { description: HOSTILE_PROMPT_TEXT };
  for (let i = 0; i < 400; i += 1) nested = { child: nested };
  const out = sanitize(nested);
  assert.ok(out !== undefined, "sanitizer should return a bounded result");
});

test("adversarial: a cyclic hostile payload terminates", () => {
  const cyclic: Record<string, unknown> = { description: HOSTILE_PROMPT_TEXT };
  cyclic.self = cyclic;
  const out = sanitize(cyclic);
  assert.ok(out !== undefined);
});

test("adversarial: a credential header cannot be injected into an outbound request", async () => {
  const safeFetch = createSafeFetch(cfg);
  await assert.rejects(
    () =>
      safeFetch.json("https://example.com/x", {
        headers: { Authorization: "Bearer injected" },
      }),
    /SECRET_ACCESS_FORBIDDEN/,
  );
  await assert.rejects(
    () => safeFetch.json("https://example.com/x", { headers: { "X-API-Key": "k" } }),
    /SECRET_ACCESS_FORBIDDEN/,
  );
});

test("adversarial: SQL-injection-shaped marketplace text is inert in SQLite", async () => {
  const { openStateDatabase, closeStateDatabase } = await import("../src/state/sqlite.js");
  const { runMigrations } = await import("../src/state/migrations.js");
  const { CommerceRepository } = await import("../src/state/repository.js");
  const { modeAWorkActionability } = await import("../src/core/models.js");

  const dir = mkdtempSync(join(tmpdir(), "hcc-sqli-"));
  try {
    const db = openStateDatabase(join(dir, "state.db"));
    runMigrations(db);
    const repo = new CommerceRepository(db);
    repo.saveWork({
      id: "wrk_00000000000000000000000000000009",
      kind: "work",
      source: "agent_bounties",
      externalId: "evil-1",
      title: HOSTILE_WORK_PAYLOAD.title,
      description: "; DROP TABLE work_items; --",
      reward: { amount: "1", asset: "USDC" },
      funding: { state: "advertised", evidence: "observed" },
      verification: { type: "unknown" },
      status: "open",
      requirements: HOSTILE_WORK_PAYLOAD.requirements,
      observedAt: "2026-08-19T00:00:00.000Z",
      evidence: [],
      actionability: modeAWorkActionability({ canPrepareClaim: true }),
    });
    // The table must still exist and hold exactly the one row.
    const n = db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number };
    assert.equal(n.n, 1);
    const stored = repo.getWork("wrk_00000000000000000000000000000009");
    assert.equal(stored?.description, "; DROP TABLE work_items; --");
    closeStateDatabase(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
