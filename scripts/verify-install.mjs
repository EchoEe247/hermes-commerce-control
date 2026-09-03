#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message, result) {
  process.stderr.write(`INSTALL_SMOKE_FAIL: ${message}\n`);
  if (result?.stdout) process.stderr.write(String(result.stdout));
  if (result?.stderr) process.stderr.write(String(result.stderr));
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 120_000,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}`, result);
  }
  return result;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    fail(`${label} did not produce parseable JSON: ${error}`);
  }
}

const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
if (packageJson.private === true) fail("package.json is still private");
if (packageJson.publishConfig?.access !== "public") {
  fail("package.json publishConfig.access must be public");
}

function assertRuntimeVersion(label, payload) {
  if (payload?.version !== packageJson.version) {
    fail(
      `${label} reported runtime version ${String(payload?.version)}; expected ${String(packageJson.version)}`,
    );
  }
}

run(npmCommand, ["run", "build"]);
const packResult = run(npmCommand, ["pack", "--json", "--ignore-scripts"]);
const packReport = parseJson("npm pack", packResult.stdout)?.[0];
const tarballName = packReport?.filename;
if (typeof tarballName !== "string" || tarballName.length === 0) {
  fail("npm pack did not report a tarball filename", packResult);
}

const tarballPath = join(repoRoot, tarballName);
const consumerRoot = await mkdtemp(join(tmpdir(), "hcc-consumer-"));
const stateRoot = join(consumerRoot, "state");

try {
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({ name: "hcc-clean-consumer", private: true, type: "module" }, null, 2) + "\n",
  );

  run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: consumerRoot },
  );

  const binDir = join(consumerRoot, "node_modules", ".bin");
  const commerce = join(binDir, process.platform === "win32" ? "commerce.cmd" : "commerce");
  const commerceMcp = join(
    binDir,
    process.platform === "win32" ? "commerce-mcp.cmd" : "commerce-mcp",
  );
  const smokeEnv = {
    ...process.env,
    HOME: consumerRoot,
    HERMES_HOME: join(consumerRoot, ".hermes"),
    COMMERCE_STATE_ROOT: stateRoot,
    COMMERCE_MODE: "B",
    EXTERNAL_WRITES_ENABLED: "true",
    LIVE_VALUE_MOVEMENT_ENABLED: "true",
    PIPRAIL_PRIVATE_KEY: "canary-not-a-real-key",
  };

  const reportedVersion = run(commerce, ["--version"], {
    cwd: consumerRoot,
    env: smokeEnv,
  }).stdout.trim();
  if (reportedVersion !== packageJson.version) {
    fail(
      `commerce --version reported ${reportedVersion}; expected ${String(packageJson.version)}`,
    );
  }

  const doctor = parseJson(
    "commerce doctor --json",
    run(commerce, ["doctor", "--json"], { cwd: consumerRoot, env: smokeEnv }).stdout,
  );
  assertRuntimeVersion("commerce doctor --json", doctor);
  const doctorData = doctor.data ?? {};
  if (doctor.ok !== true) fail("clean-installed doctor is not healthy");
  if (doctorData.mode !== "A") fail("clean-installed launcher did not force Mode A");
  if (doctorData.externalWritesEnabled !== false) fail("external writes were not forced off");
  if (doctorData.liveValueMovementEnabled !== false) fail("live value movement was not forced off");
  if (doctorData.walletSecretPresent !== false) fail("wallet-shaped environment data was not scrubbed");

  const status = parseJson(
    "commerce status --json",
    run(commerce, ["status", "--json"], { cwd: consumerRoot, env: smokeEnv }).stdout,
  );
  assertRuntimeVersion("commerce status --json", status);
  if (status.ok !== true) fail("clean-installed status command failed");
  if (status.data?.version !== packageJson.version) {
    fail(
      `commerce status data version ${String(status.data?.version)} does not match ${String(packageJson.version)}`,
    );
  }

  const sources = parseJson(
    "commerce sources --json",
    run(commerce, ["sources", "--json"], { cwd: consumerRoot, env: smokeEnv }).stdout,
  );
  assertRuntimeVersion("commerce sources --json", sources);
  if (sources.ok !== true) fail("clean-installed sources command failed");

  const handshakeInput = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"package-smoke","version":"1.0.0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    "",
  ].join("\n");
  const handshake = run(commerceMcp, [], {
    cwd: consumerRoot,
    env: smokeEnv,
    input: handshakeInput,
    timeout: 30_000,
  });
  const messages = handshake.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson("MCP stdout line", line));
  const listed = messages.find((message) => message.id === 2);
  const names = (listed?.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = [
    "commerce_discover_services",
    "commerce_discover_work",
    "commerce_export_evidence",
    "commerce_inspect",
    "commerce_prepare_claim",
    "commerce_prepare_publish",
    "commerce_prepare_purchase",
    "commerce_probe",
    "commerce_quote",
    "commerce_sources",
    "commerce_status",
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`clean-installed MCP tool set drifted: ${names.join(",")}`, handshake);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        package: `${packageJson.name}@${packageJson.version}`,
        runtimeVersion: reportedVersion,
        tarball: tarballName,
        installedCommands: ["commerce", "commerce-mcp"],
        cliChecks: ["--version", "doctor", "status", "sources"],
        mcpTools: names.length,
        zeroSecretStartup: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
  await rm(tarballPath, { force: true });
}
