import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openStateDatabase, closeStateDatabase } from "../dist/state/sqlite.js";
import { runMigrations } from "../dist/state/migrations.js";
import { CommerceRepository } from "../dist/state/repository.js";
import { rankServices } from "../dist/ranking/services.js";
import { modeAServiceActionability } from "../dist/core/models.js";

console.log("=== Hermes Commerce Control Plane Micro-Benchmarks ===");

// 1. Simple SQLite operation
function benchSqlite() {
  const dir = mkdtempSync(join(tmpdir(), "hcc-bench-sqlite-"));
  const dbPath = join(dir, "commerce.db");
  const t0 = performance.now();
  const db = openStateDatabase(dbPath);
  runMigrations(db);
  const repo = new CommerceRepository(db);
  
  // Perform some inserts and selects
  for (let i = 0; i < 100; i++) {
    repo.saveProbe({
      platform: "cdp_bazaar",
      status: "ok",
      checkedAt: new Date().toISOString(),
      latencyMs: i,
    });
  }
  const count = repo.listProbes("cdp_bazaar").length;
  closeStateDatabase(db);
  rmSync(dir, { recursive: true, force: true });
  const t1 = performance.now();
  return {
    timeMs: t1 - t0,
    count,
  };
}

// 2. Intent Hashing / Creation
function benchIntentCreation() {
  const dir = mkdtempSync(join(tmpdir(), "hcc-bench-intent-"));
  const dbPath = join(dir, "commerce.db");
  const db = openStateDatabase(dbPath);
  runMigrations(db);
  const repo = new CommerceRepository(db);
  
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    repo.saveIntent({
      id: `intent_${i}`,
      kind: "payment",
      platform: "cdp_bazaar",
      targetId: `svc_${i}`,
      createdAt: new Date().toISOString(),
      hash: "abc" + i,
      body: { some: "payload", i },
      decisionRule: "A_MODE_VALUE_MOVEMENT",
      decisionOutcome: "block",
      financialActionExecuted: false,
      externalMutationExecuted: false,
    });
  }
  const count = repo.listIntents().length;
  closeStateDatabase(db);
  rmSync(dir, { recursive: true, force: true });
  const t1 = performance.now();
  return {
    timeMs: t1 - t0,
    count,
  };
}

// 3. 1k Normalization and 1k Ranking
function benchNormalizationAndRanking() {
  // Generate 1000 candidate services
  const candidates = [];
  for (let i = 0; i < 1000; i++) {
    candidates.push({
      id: `svc_candidate_${i}`,
      kind: "service",
      sources: [{ source: "cdp_bazaar", externalId: `res_${i}`, observedAt: new Date().toISOString(), sourceUrl: "bazaar" }],
      name: `Service Number ${i}`,
      description: `A sample description for testing the performance of the ranking algorithm. Candidate ${i}.`,
      resourceUrl: `https://api.bazaar.com/v2/item/${i}`,
      method: "POST",
      protocol: "x402",
      network: "eip155:8453",
      asset: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      price: { atomic: String(1000 + i * 10), decimal: String(0.001 + i * 0.00001), display: `$${(0.001 + i * 0.00001).toFixed(6)}`, currency: "USDC", usd: String(0.001 + i * 0.00001) },
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      health: i % 20 === 0 ? "degraded" : "ok",
      observedAt: new Date().toISOString(),
      tags: ["performance-test"],
      evidence: [],
      actionability: modeAServiceActionability({ canQuote: true, canPreparePurchase: true }),
    });
  }

  const t0 = performance.now();
  // We mock a simple normalization pass
  const normalized = candidates.map(c => ({
    ...c,
    observedAt: new Date().toISOString()
  }));
  const t1 = performance.now();

  const t2 = performance.now();
  const ranked = rankServices(normalized, {
    maxUsdPrice: "100.00",
    network: "eip155:8453",
  });
  const t3 = performance.now();

  return {
    normMs: t1 - t0,
    rankMs: t3 - t2,
    rankedCount: ranked.length,
  };
}

// 4. MCP Idle RSS Footprint (spawns mcp wrapper/script as a child process and queries memory)
async function benchMcpIdleRss() {
  return new Promise((resolve) => {
    // Spawns a child process that imports the app, boots in mcp mode, and prints its memory usage before exiting.
    const proc = spawn("node", [
      "-e",
      "import('./dist/app.js').then(() => { setTimeout(() => { console.log(process.memoryUsage().rss); process.exit(0); }, 500); })"
    ], {
      env: { ...process.env, COMMERCE_MODE: "A" }
    });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", () => {
      const bytes = parseInt(out.trim(), 10);
      if (Number.isFinite(bytes)) {
        resolve(bytes / (1024 * 1024)); // MB
      } else {
        resolve(null);
      }
    });
  });
}

// 5. Measure CLI status invocation duration
function benchCliStatus() {
  const t0 = performance.now();
  const proc = spawn("node", ["dist/cli.js", "status", "--json"], {
    env: { ...process.env, COMMERCE_MODE: "A" }
  });
  return new Promise((resolve) => {
    proc.on("close", () => {
      const t1 = performance.now();
      resolve(t1 - t0);
    });
  });
}

const sqliteMetrics = benchSqlite();
const intentMetrics = benchIntentCreation();
const listMetrics = benchNormalizationAndRanking();
const mcpRss = await benchMcpIdleRss();
const cliStatusDuration = await benchCliStatus();

console.log(`Local status command duration:    ${cliStatusDuration.toFixed(2)} ms`);
console.log(`SQLite database setup & 100 ops: ${sqliteMetrics.timeMs.toFixed(2)} ms (probes saved: ${sqliteMetrics.count})`);
console.log(`Intent creation (100 operations): ${intentMetrics.timeMs.toFixed(2)} ms (intents saved: ${intentMetrics.count})`);
console.log(`1k Candidates Normalization:      ${listMetrics.normMs.toFixed(2)} ms`);
console.log(`1k Candidates Deterministic Rank: ${listMetrics.rankMs.toFixed(2)} ms (ranked matches: ${listMetrics.rankedCount})`);
if (mcpRss !== null) {
  console.log(`MCP standalone idle RSS:          ${mcpRss.toFixed(2)} MB`);
} else {
  console.log(`MCP standalone idle RSS:          not available`);
}
console.log("======================================================");
