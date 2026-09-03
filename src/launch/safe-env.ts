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

/** Returns true when an environment-variable name can carry wallet authority. */
export function isWalletSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return WALLET_SECRET_ENV_FRAGMENTS.some((fragment) => upper.includes(fragment));
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
