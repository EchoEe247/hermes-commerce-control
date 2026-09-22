import type { Env } from "../config.js";

/**
 * Environment-name fragments that imply wallet or financial-signing authority.
 *
 * Launchers remove matching variables before importing the application so the
 * Mode-A "no signer is reachable" guarantee does not depend on shell hygiene.
 * This is intentionally narrower than the generic credential denylist: an API
 * token may be a hygiene concern, but it is not itself wallet signing authority.
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

const WALLET_AUTHORITY_CONTEXT_TOKENS = new Set([
  "ACCOUNT",
  "BITCOIN",
  "BTC",
  "CRYPTO",
  "ETH",
  "ETHEREUM",
  "EVM",
  "PRIVATE",
  "SIGNING",
  "SOLANA",
  "WALLET",
]);

function envNameTokens(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .split("_")
    .filter((token) => token !== "");
}

/** Returns true when an environment-variable name can carry wallet authority. */
export function isWalletSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (WALLET_SECRET_ENV_FRAGMENTS.some((fragment) => upper.includes(fragment))) return true;

  const tokens = envNameTokens(name);

  // A signer is authority by definition. Token matching avoids false positives
  // such as DESIGNER_THEME while still catching ACCOUNT_SIGNER and signer_key.
  if (tokens.includes("SIGNER")) return true;

  // A bare SEED can be wallet authority. Scoped seed names are removed only
  // when their surrounding tokens indicate a wallet/signing context, so benign
  // values such as RANDOM_SEED are not deleted indiscriminately.
  if (!tokens.includes("SEED")) return false;
  if (tokens.length === 1) return true;
  return tokens.some((token) => WALLET_AUTHORITY_CONTEXT_TOKENS.has(token));
}

/**
 * Hardens a mutable process environment for a Mode-A launch.
 *
 * The operation is deliberately performed before dynamically importing either
 * the CLI or MCP server. That makes the package launcher itself the security
 * boundary on every platform rather than relying on a generated shell wrapper.
 *
 * The returned names are diagnostic only; values are never copied or returned.
 */
export function hardenModeAEnvironment(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const removed: string[] = [];

  for (const name of Object.keys(env)) {
    if (!isWalletSecretEnvName(name)) continue;
    delete env[name];
    removed.push(name);
  }

  env.COMMERCE_MODE = "A";
  env.EXTERNAL_WRITES_ENABLED = "false";
  env.LIVE_VALUE_MOVEMENT_ENABLED = "false";

  return Object.freeze(removed.sort());
}

/** Read-only view helper used by tests and diagnostics without exposing values. */
export function walletSecretEnvNames(env: Env): readonly string[] {
  return Object.freeze(
    Object.entries(env)
      .filter(([name, value]) => typeof value === "string" && value.trim() !== "" && isWalletSecretEnvName(name))
      .map(([name]) => name)
      .sort(),
  );
}
