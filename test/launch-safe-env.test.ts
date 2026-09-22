import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hardenModeAEnvironment,
  isWalletSecretEnvName,
  walletSecretEnvNames,
} from "../src/launch/safe-env.js";

test("wallet-secret name matching is case-insensitive and intentionally narrow", () => {
  assert.equal(isWalletSecretEnvName("PIPRAIL_PRIVATE_KEY"), true);
  assert.equal(isWalletSecretEnvName("agentMnemonicBackup"), true);
  assert.equal(isWalletSecretEnvName("wallet_nwc_uri"), true);
  assert.equal(isWalletSecretEnvName("WALLET_SEED"), true);
  assert.equal(isWalletSecretEnvName("ACCOUNT_SEED"), true);
  assert.equal(isWalletSecretEnvName("SEED"), true);
  assert.equal(isWalletSecretEnvName("SIGNER"), true);
  assert.equal(isWalletSecretEnvName("SIGNER_KEY"), true);
  assert.equal(isWalletSecretEnvName("accountSigner"), true);
  assert.equal(isWalletSecretEnvName("OPENAI_API_KEY"), false);
  assert.equal(isWalletSecretEnvName("SESSION_TOKEN"), false);
  assert.equal(isWalletSecretEnvName("DESIGNER_THEME"), false);
  assert.equal(isWalletSecretEnvName("RANDOM_SEED"), false);
});

test("Mode-A hardening deletes seed/signer authority variants before launch", () => {
  const env: NodeJS.ProcessEnv = {
    WALLET_SEED: "canary-wallet-seed",
    ACCOUNT_SEED: "canary-account-seed",
    SEED: "canary-bare-seed",
    SIGNER: "canary-signer",
    SIGNER_KEY: "canary-signer-key",
    ACCOUNT_SIGNER: "canary-account-signer",
    DESIGNER_THEME: "dark",
    RANDOM_SEED: "42",
  };

  const removed = hardenModeAEnvironment(env);

  assert.deepEqual(
    removed,
    ["ACCOUNT_SEED", "ACCOUNT_SIGNER", "SEED", "SIGNER", "SIGNER_KEY", "WALLET_SEED"].sort(),
  );
  for (const name of removed) assert.equal(env[name], undefined);
  assert.equal(env.DESIGNER_THEME, "dark");
  assert.equal(env.RANDOM_SEED, "42");
});

test("Mode-A hardening deletes wallet authority before launch and forces safety gates", () => {
  const env: NodeJS.ProcessEnv = {
    PIPRAIL_PRIVATE_KEY: "canary-private-key",
    operatorMnemonic: "canary-mnemonic",
    NWC_CONNECTION: "nostr+walletconnect://canary",
    OPENAI_API_KEY: "ordinary-api-token",
    COMMERCE_MODE: "B",
    EXTERNAL_WRITES_ENABLED: "true",
    LIVE_VALUE_MOVEMENT_ENABLED: "1",
    COMMERCE_REPO_ROOT: "/tmp/workspace",
  };

  const removed = hardenModeAEnvironment(env);

  assert.deepEqual(removed, ["NWC_CONNECTION", "PIPRAIL_PRIVATE_KEY", "operatorMnemonic"].sort());
  assert.equal(env.PIPRAIL_PRIVATE_KEY, undefined);
  assert.equal(env.operatorMnemonic, undefined);
  assert.equal(env.NWC_CONNECTION, undefined);

  assert.equal(env.COMMERCE_MODE, "A");
  assert.equal(env.EXTERNAL_WRITES_ENABLED, "false");
  assert.equal(env.LIVE_VALUE_MOVEMENT_ENABLED, "false");

  assert.equal(env.OPENAI_API_KEY, "ordinary-api-token");
  assert.equal(env.COMMERCE_REPO_ROOT, "/tmp/workspace");
});

test("walletSecretEnvNames reports names only and ignores empty values", () => {
  const names = walletSecretEnvNames({
    FIRST_PRIVATE_KEY: "set",
    SECOND_PRIVATE_KEY: "   ",
    NWC_URI: "set",
    API_TOKEN: "set",
  });

  assert.deepEqual(names, ["FIRST_PRIVATE_KEY", "NWC_URI"]);
});
