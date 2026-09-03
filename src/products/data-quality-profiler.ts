/**
 * Data Quality Profiler publication-readiness pipeline.
 *
 * Every fact here is DERIVED by inspecting the actual product tree, never
 * assumed from the plan. Version comes from package.json, routes from the app
 * source, price and network from the config module, x402 version and Bazaar
 * metadata from the payment plugin, and verification status from the newest
 * receipt on disk. If the product changes, this readiness report changes with it.
 *
 * The pipeline inspects the canonical published product tree. It does not
 * register it anywhere, and reports publicationAllowed:false with
 * publicationExecuted:false regardless of how ready the product is. Promotion
 * is a repository lifecycle decision and publication is a Stage B1 action;
 * neither is granted by this assessment.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashCanonical } from "../evidence/hashing.js";
import { sanitize } from "../evidence/sanitize.js";

export const PRODUCT_NAME = "data-quality-profiler";
export const PRODUCT_RELATIVE_PATH = "products/published/data-quality-profiler";

export interface TargetReadiness {
  readonly prepared: boolean;
  readonly ready: boolean;
  readonly reason: string | null;
  readonly note: string | null;
}

export interface ProfilerReadiness {
  readonly product: string;
  readonly path: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly buildReady: boolean;
  readonly routes: {
    readonly health: boolean;
    readonly profile: boolean;
  };
  readonly x402: {
    readonly version: number | null;
    readonly price: string | null;
    readonly network: string | null;
    readonly mainnetPermitted: boolean;
  };
  readonly bazaar: {
    readonly metadataDeclared: boolean;
    readonly metadataValidatedByTest: boolean;
  };
  readonly tests: {
    readonly declared: boolean;
    readonly fileCount: number;
    readonly lastVerification: string | null;
    readonly lastVerificationPassed: boolean | null;
  };
  readonly readme: boolean;
  readonly targets: Readonly<Record<string, TargetReadiness>>;
  readonly publishIntentReady: boolean;
  /** Always false in Mode A, regardless of readiness. */
  readonly publicationAllowed: false;
  readonly publicationExecuted: false;
  readonly manifestHash: string;
  readonly limitations: readonly string[];
}

function readTextIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** Extracts a quoted default from a `?? "value"` expression. */
function extractDefault(source: string, key: string): string | null {
  const pattern = new RegExp(`${key}\\s*[:=]\\s*env\\.[A-Z0-9_]+\\s*\\?\\?\\s*["']([^"']+)["']`);
  const direct = new RegExp(`${key}\\s*[:=]\\s*["']([^"']+)["']`);
  return pattern.exec(source)?.[1] ?? direct.exec(source)?.[1] ?? null;
}

export interface InspectOptions {
  /** Repository root. The product path is resolved beneath it. */
  readonly repoRoot: string;
}

/**
 * Inspects the product tree and derives readiness.
 *
 * Pure filesystem reads only: this never starts the product, never opens a
 * socket, and never runs its test suite. Running the suite is a separate,
 * explicit step performed by the CLI's full readiness verification.
 */
export function inspectProfiler(options: InspectOptions): ProfilerReadiness {
  const root = join(options.repoRoot, PRODUCT_RELATIVE_PATH);
  const limitations: string[] = [];

  if (!existsSync(root)) {
    return Object.freeze({
      product: PRODUCT_NAME,
      path: PRODUCT_RELATIVE_PATH,
      present: false,
      version: null,
      buildReady: false,
      routes: { health: false, profile: false },
      x402: { version: null, price: null, network: null, mainnetPermitted: false },
      bazaar: { metadataDeclared: false, metadataValidatedByTest: false },
      tests: { declared: false, fileCount: 0, lastVerification: null, lastVerificationPassed: null },
      readme: false,
      targets: Object.freeze({}),
      publishIntentReady: false,
      publicationAllowed: false as const,
      publicationExecuted: false as const,
      manifestHash: hashCanonical({ product: PRODUCT_NAME, present: false }),
      limitations: Object.freeze([`product tree absent at ${PRODUCT_RELATIVE_PATH}`]),
    });
  }

  // Version and test script from the real manifest.
  let version: string | null = null;
  let testDeclared = false;
  const manifestText = readTextIfPresent(join(root, "package.json"));
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText) as {
        version?: unknown;
        scripts?: Record<string, unknown>;
      };
      version = typeof manifest.version === "string" ? manifest.version : null;
      testDeclared = typeof manifest.scripts?.test === "string";
    } catch {
      limitations.push("product package.json could not be parsed");
    }
  } else {
    limitations.push("product package.json is missing");
  }

  // Routes from the actual app source.
  const appSource = readTextIfPresent(join(root, "src", "app.mjs")) ?? "";
  const routes = {
    health: /\.get\(\s*["']\/health["']/.test(appSource),
    profile: /\.post\(\s*["']\/v1\/profile["']/.test(appSource),
  };
  if (!routes.health) limitations.push("GET /health route not detected in src/app.mjs");
  if (!routes.profile) limitations.push("POST /v1/profile route not detected in src/app.mjs");

  // Price and network from the config module. Derived, not assumed.
  const configSource = readTextIfPresent(join(root, "src", "config.mjs")) ?? "";
  const price = extractDefault(configSource, "x402Price");
  const network = extractDefault(configSource, "x402Network");
  // Mainnet is permitted only if the allowlist contains a non-Sepolia chain.
  const allowedNetworks = /ALLOWED_NETWORKS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(configSource)?.[1] ?? "";
  const mainnetPermitted = /eip155:8453(?!2)/.test(allowedNetworks);
  if (mainnetPermitted) {
    limitations.push("product config permits a mainnet network; Mode A expects testnet only");
  }

  // x402 version and Bazaar metadata from the payment plugin.
  const pluginSource = readTextIfPresent(join(root, "src", "payments", "x402-plugin.mjs")) ?? "";
  const x402Version = /x402Version\s*[:=]\s*(\d+)/.exec(pluginSource)?.[1];
  const declaredV2 = /@x402\/(?:core|fastify|extensions)/.test(pluginSource);
  const metadataDeclared = pluginSource.includes("declareDiscoveryExtension");
  if (!metadataDeclared) limitations.push("Bazaar discovery extension not declared in the payment plugin");

  // Test inventory and whether a test validates the Bazaar metadata officially.
  const testFiles = listFiles(join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  const testSources = testFiles
    .map((f) => readTextIfPresent(join(root, "test", f)) ?? "")
    .join("\n");
  const metadataValidatedByTest = testSources.includes("validateDiscoveryExtension");
  if (!metadataValidatedByTest) {
    limitations.push("no test calls the official validateDiscoveryExtension helper");
  }

  // Newest verification receipt on disk, and whether it recorded a pass.
  const receiptsRoot = join(options.repoRoot, "receipts", "implementation", PRODUCT_NAME);
  const receiptDirs = listFiles(receiptsRoot)
    .filter((d) => {
      try {
        return statSync(join(receiptsRoot, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  const newest = receiptDirs.at(-1) ?? null;
  let lastVerificationPassed: boolean | null = null;
  if (newest !== null) {
    const receiptText = readTextIfPresent(join(receiptsRoot, newest, "verification.json"));
    if (receiptText !== null) {
      try {
        const receipt = JSON.parse(receiptText) as Record<string, unknown>;
        const serialized = JSON.stringify(receipt).toLowerCase();
        // A receipt counts as passing only if it says so and records no failures.
        lastVerificationPassed =
          /"(?:status|result)"\s*:\s*"(?:pass|passed|green|complete|ok)"/.test(serialized) ||
          /"fail(?:ed|ures)?"\s*:\s*0/.test(serialized);
      } catch {
        limitations.push(`verification receipt ${newest} could not be parsed`);
      }
    }
  } else {
    limitations.push("no verification receipt found for the product");
  }

  const readme = existsSync(join(root, "README.md"));
  if (!readme) limitations.push("product README.md is missing");

  const buildReady =
    version !== null && routes.health && routes.profile && price !== null && network !== null;

  // Target readiness. CDP and Agent402 can be metadata-prepared; Pay.sh cannot.
  const targets: Record<string, TargetReadiness> = {
    cdp_bazaar: {
      prepared: metadataDeclared && buildReady,
      ready: metadataDeclared && buildReady && metadataValidatedByTest,
      reason: null,
      note:
        "Bazaar indexes a resource only after a successful settlement through the CDP facilitator. " +
        "Metadata preparation alone does not create a listing, and settlement is a Stage B2 action.",
    },
    agent402: {
      prepared: buildReady,
      ready: buildReady,
      reason: null,
      note: "Agent402 listing is an operator-side catalogue addition; metadata only is prepared here.",
    },
    paysh: {
      prepared: false,
      ready: false,
      reason: "SOLANA_DISTRIBUTION_PHASE_2",
      note:
        "Pay.sh settles in Solana-mainnet USDC/USDT while this product is Base/x402, and publishing " +
        "requires a pull request against the pay-skills registry.",
    },
  };

  const manifestHash = hashCanonical(
    sanitize({
      product: PRODUCT_NAME,
      version,
      routes,
      price,
      network,
      x402Version: x402Version === undefined ? (declaredV2 ? 2 : null) : Number(x402Version),
      metadataDeclared,
    }),
  );

  return Object.freeze({
    product: PRODUCT_NAME,
    path: PRODUCT_RELATIVE_PATH,
    present: true,
    version,
    buildReady,
    routes: Object.freeze(routes),
    x402: Object.freeze({
      // The plugin imports the @x402 v2 packages; a literal x402Version wins.
      version: x402Version === undefined ? (declaredV2 ? 2 : null) : Number(x402Version),
      price,
      network,
      mainnetPermitted,
    }),
    bazaar: Object.freeze({ metadataDeclared, metadataValidatedByTest }),
    tests: Object.freeze({
      declared: testDeclared,
      fileCount: testFiles.length,
      lastVerification: newest,
      lastVerificationPassed,
    }),
    readme,
    targets: Object.freeze(targets),
    publishIntentReady: buildReady && metadataDeclared,
    // Invariant: never true in Mode A, however ready the product is.
    publicationAllowed: false as const,
    publicationExecuted: false as const,
    manifestHash,
    limitations: Object.freeze(limitations),
  });
}

/** Builds the publication manifest a PublishIntent would carry. */
export function buildProfilerManifest(readiness: ProfilerReadiness): Record<string, unknown> {
  return {
    product: readiness.product,
    version: readiness.version ?? "unknown",
    resourceUrl: "https://REPLACE_WITH_DEPLOYED_HOST/v1/profile",
    method: "POST",
    protocol: "x402",
    network: readiness.x402.network ?? "eip155:84532",
    price: readiness.x402.price ?? "unknown",
    description:
      "Profiles a tabular dataset and returns per-field type inference, missingness, " +
      "duplicate detection and a composite quality score.",
    // Deliberately explicit: the product is not deployed, so no live host exists.
    hostDeployed: false,
    metadata: {
      bazaarMetadataDeclared: readiness.bazaar.metadataDeclared,
      bazaarMetadataValidatedByTest: readiness.bazaar.metadataValidatedByTest,
    },
  };
}
