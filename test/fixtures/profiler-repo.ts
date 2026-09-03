import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the smallest repository-shaped Data Quality Profiler tree needed by
 * inspectProfiler(). This keeps HCC's unit tests independent from the parent
 * agent-commerce-hub checkout while preserving the same derived facts.
 */
export function createProfilerRepositoryFixture(repoRoot: string): void {
  const productRoot = join(repoRoot, "products", "published", "data-quality-profiler");
  const productSrc = join(productRoot, "src");
  const payments = join(productSrc, "payments");
  const tests = join(productRoot, "test");
  const receiptRoot = join(
    repoRoot,
    "receipts",
    "implementation",
    "data-quality-profiler",
    "20260819-031500",
  );

  mkdirSync(payments, { recursive: true });
  mkdirSync(tests, { recursive: true });
  mkdirSync(receiptRoot, { recursive: true });

  writeFileSync(
    join(productRoot, "package.json"),
    JSON.stringify({
      name: "data-quality-profiler-fixture",
      version: "0.1.0",
      scripts: { test: "node --test" },
    }),
  );

  writeFileSync(
    join(productSrc, "app.mjs"),
    'app.get("/health", async () => ({}));\napp.post("/v1/profile", async () => ({}));\n',
  );

  writeFileSync(
    join(productSrc, "config.mjs"),
    'const ALLOWED_NETWORKS = new Set(["eip155:84532"]);\n' +
      'const x402Network = env.X402_NETWORK ?? "eip155:84532";\n' +
      'x402Price: env.X402_PRICE ?? "$0.02",\n',
  );

  writeFileSync(
    join(payments, "x402-plugin.mjs"),
    'import "@x402/core";\nconst x402Version = 2;\nconst metadata = declareDiscoveryExtension({});\nvoid x402Version;\nvoid metadata;\n',
  );

  // inspectProfiler derives test inventory and the official Bazaar-validation
  // signal from test source. Keep ten tiny files to exercise the inventory path
  // without importing the real product's test suite.
  for (let i = 0; i < 10; i += 1) {
    writeFileSync(
      join(tests, `fixture-${String(i).padStart(2, "0")}.test.mjs`),
      i === 0
        ? "validateDiscoveryExtension(metadata);\n"
        : `// standalone profiler fixture test ${String(i)}\n`,
    );
  }

  writeFileSync(join(productRoot, "README.md"), "# Data Quality Profiler fixture\n");
  writeFileSync(
    join(receiptRoot, "verification.json"),
    JSON.stringify({ status: "pass", failures: 0 }),
  );
}
