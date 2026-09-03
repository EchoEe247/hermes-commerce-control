/**
 * Environment and policy self-diagnosis.
 *
 * The doctor answers one question: "is this installation in a state where the
 * Mode-A guarantees actually hold on this device?" It therefore checks the
 * runtime the plan commits to (Node 24 with built-in `node:sqlite`), the local
 * state it must be able to write, and the policy invariants that make the
 * control plane safe.
 *
 * Two design rules matter:
 *
 *  1. A missing *capability* is a failure; a missing *convenience* is a warning.
 *     An unwritable state directory is fatal because nothing can be recorded. An
 *     absent `dist/` is a warning because the source can still be run through
 *     tsx, and the installer builds it.
 *  2. The doctor reports environment-variable NAMES, never values. It exists to
 *     prove a wallet secret is absent, so it must not become the thing that
 *     leaks one.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_MODE, APP_VERSION } from "./app.js";
import { isSecretEnvName, type CommerceConfig, type Env } from "./config.js";
import { PLATFORM_IDS } from "./core/models.js";
import { currentSchemaVersion, runMigrations } from "./state/migrations.js";
import { closeStateDatabase, openStateDatabase } from "./state/sqlite.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  /** False when any check failed. Warnings never make the report unhealthy. */
  readonly ok: boolean;
  readonly mode: typeof APP_MODE;
  readonly version: typeof APP_VERSION;
  readonly externalWritesEnabled: false;
  readonly liveValueMovementEnabled: false;
  /** True when a wallet/financial-signing secret is present in the environment. */
  readonly walletSecretPresent: boolean;
  /** NAMES only, never values. */
  readonly walletSecretEnvNames: readonly string[];
  /** Broader credential-shaped names, reported as hygiene information only. */
  readonly flaggedEnvNames: readonly string[];
  readonly node: { readonly version: string; readonly major: number };
  readonly paths: {
    readonly packageRoot: string;
    readonly stateRoot: string;
    readonly databasePath: string;
    readonly repoRoot: string;
  };
  readonly checks: readonly DoctorCheck[];
  readonly summary: { readonly pass: number; readonly warn: number; readonly fail: number };
  readonly checkedAt: string;
}

/**
 * Environment-variable fragments that indicate a WALLET or financial signing
 * secret specifically.
 *
 * This is deliberately narrower than the broad credential denylist in config.
 * The Mode-A prohibition is about spending authority: a generic API token is a
 * hygiene concern, whereas a private key or mnemonic is the exact thing that
 * would make live value movement possible. Conflating them would turn every
 * ordinary developer shell into a fatal error and train an operator to ignore
 * the check.
 */
export const WALLET_SECRET_ENV_FRAGMENTS: readonly string[] = Object.freeze([
  "PRIVATE_KEY",
  "PRIVATEKEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "SEEDPHRASE",
  "WALLET_SECRET",
  "SIGNING_KEY",
  "KEYSTORE",
  "XPRV",
  "NWC",
]);

/** Returns the NAMES of set, non-empty wallet-secret variables. */
export function findWalletSecretEnvNames(env: Env): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const upper = name.toUpperCase();
    if (WALLET_SECRET_ENV_FRAGMENTS.some((fragment) => upper.includes(fragment))) hits.push(name);
  }
  return hits.sort();
}

/** Returns the NAMES of set, non-empty broadly credential-shaped variables. */
export function findFlaggedEnvNames(env: Env): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (isSecretEnvName(name)) hits.push(name);
  }
  return hits.sort();
}

/** Package root, resolved from this module so it works from src/ or dist/. */
export function resolvePackageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

export interface DoctorOptions {
  readonly config: CommerceConfig;
  readonly env: Env;
  /** Number of adapters the caller registered. */
  readonly adapterCount: number;
  readonly clock?: (() => string) | undefined;
  readonly packageRoot?: string | undefined;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { config, env } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const checks: DoctorCheck[] = [];

  const add = (id: string, status: CheckStatus, detail: string): void => {
    checks.push({ id, status, detail });
  };

  // ------------------------------------------------------------------ runtime
  const nodeVersion = process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (major === 24) {
    add("node_version", "pass", `Node ${nodeVersion} matches the committed Node 24 runtime`);
  } else {
    add(
      "node_version",
      "fail",
      `Node ${nodeVersion} is not Node 24; this package targets Node 24 with built-in node:sqlite`,
    );
  }

  try {
    const sqlite = await import("node:sqlite");
    if (typeof sqlite.DatabaseSync === "function") {
      add("node_sqlite", "pass", "built-in node:sqlite DatabaseSync is available");
    } else {
      add("node_sqlite", "fail", "node:sqlite loaded but DatabaseSync is missing");
    }
  } catch (error) {
    add(
      "node_sqlite",
      "fail",
      `built-in node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ------------------------------------------------------------------- policy
  add(
    "mode_a",
    config.mode === "A" ? "pass" : "fail",
    `configuration mode is ${config.mode}; only Mode A is implemented`,
  );
  add(
    "external_writes_disabled",
    config.externalWritesEnabled === false ? "pass" : "fail",
    "EXTERNAL_WRITES_ENABLED is false; Stage B1 is not implemented",
  );
  add(
    "live_value_movement_disabled",
    config.liveValueMovementEnabled === false ? "pass" : "fail",
    "LIVE_VALUE_MOVEMENT_ENABLED is false; Stage B2 is not implemented",
  );

  const walletSecretEnvNames = findWalletSecretEnvNames(env);
  const flaggedEnvNames = findFlaggedEnvNames(env);
  if (walletSecretEnvNames.length === 0) {
    add("wallet_secret_absent", "pass", "no wallet or financial signing secret is present");
  } else {
    add(
      "wallet_secret_absent",
      "fail",
      `wallet/signing secret variables are set: ${walletSecretEnvNames.join(", ")}. ` +
        "Mode A must run with no spending authority available to the process.",
    );
  }
  if (flaggedEnvNames.length === 0) {
    add("credential_env_clean", "pass", "no credential-shaped environment variable is set");
  } else {
    add(
      "credential_env_clean",
      "warn",
      `credential-shaped variables are visible to this process: ${flaggedEnvNames.join(", ")}. ` +
        "None is read into configuration, evidence, exports or logs.",
    );
  }

  // -------------------------------------------------------------------- state
  let stateWritable = false;
  try {
    mkdirSync(config.stateRoot, { recursive: true });
    const probe = join(config.stateRoot, ".doctor-write-probe");
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    stateWritable = true;
    add("state_writable", "pass", `state root is writable at ${config.stateRoot}`);
  } catch (error) {
    add(
      "state_writable",
      "fail",
      `state root ${config.stateRoot} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (stateWritable) {
    try {
      const db = openStateDatabase(config.databasePath);
      try {
        const outcome = runMigrations(db);
        const expected = currentSchemaVersion();
        add(
          "state_migrations",
          outcome.appliedTo === expected ? "pass" : "fail",
          `schema version ${String(outcome.appliedTo)} of expected ${String(expected)}`,
        );
      } finally {
        closeStateDatabase(db);
      }
    } catch (error) {
      add(
        "state_migrations",
        "fail",
        `migrations could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    add("state_migrations", "fail", "skipped because the state root is not writable");
  }

  // ----------------------------------------------------------------- adapters
  add(
    "adapters_registered",
    options.adapterCount === PLATFORM_IDS.length ? "pass" : "warn",
    `${String(options.adapterCount)} of ${String(PLATFORM_IDS.length)} platform adapters registered`,
  );

  // -------------------------------------------------------------------- paths
  if (existsSync(config.repoRoot)) {
    add("repo_root", "pass", `repository root resolved at ${config.repoRoot}`);
  } else {
    add(
      "repo_root",
      "warn",
      `repository root ${config.repoRoot} does not exist yet; export will create it`,
    );
  }

  const cliEntry = join(packageRoot, "dist", "cli.js");
  if (existsSync(cliEntry)) {
    add("build_artifact", "pass", `compiled CLI entrypoint present at ${cliEntry}`);
  } else {
    add(
      "build_artifact",
      "warn",
      `compiled CLI entrypoint missing at ${cliEntry}; run npm run build`,
    );
  }

  // The MCP entrypoint is what Hermes launches. A missing one is a warning
  // rather than a failure because the source still runs through tsx and the
  // installer builds it before registering anything.
  const mcpEntry = join(packageRoot, "dist", "mcp", "server.js");
  if (existsSync(mcpEntry)) {
    add("mcp_entrypoint", "pass", `compiled MCP entrypoint present at ${mcpEntry}`);
  } else {
    add(
      "mcp_entrypoint",
      "warn",
      `compiled MCP entrypoint missing at ${mcpEntry}; run npm run build before registering with Hermes`,
    );
  }

  // Filesystem-only observation. The doctor deliberately spawns no subprocess,
  // so it reports whether a Hermes home exists rather than interrogating the
  // Hermes CLI; the installer does that verification itself.
  const hermesHome = join(homedir(), ".hermes");
  if (existsSync(hermesHome)) {
    add("hermes_home", "pass", `Hermes home found at ${hermesHome}`);
  } else {
    add(
      "hermes_home",
      "warn",
      `no Hermes home at ${hermesHome}; MCP registration will be unavailable until Hermes is installed`,
    );
  }

  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };

  return Object.freeze({
    ok: summary.fail === 0,
    mode: APP_MODE,
    version: APP_VERSION,
    externalWritesEnabled: false as const,
    liveValueMovementEnabled: false as const,
    walletSecretPresent: walletSecretEnvNames.length > 0,
    walletSecretEnvNames: Object.freeze(walletSecretEnvNames),
    flaggedEnvNames: Object.freeze(flaggedEnvNames),
    node: Object.freeze({ version: nodeVersion, major }),
    paths: Object.freeze({
      packageRoot,
      stateRoot: config.stateRoot,
      databasePath: config.databasePath,
      repoRoot: config.repoRoot,
    }),
    checks: Object.freeze(checks),
    summary: Object.freeze(summary),
    checkedAt: clock(),
  });
}
