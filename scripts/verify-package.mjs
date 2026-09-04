#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const registryManifest = JSON.parse(
  await readFile(new URL("../server.json", import.meta.url), "utf8"),
);
const errors = [];
const expectedMcpName = "io.github.EchoEe247/hermes-commerce-control";
const expectedSchema = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

if (manifest.private === true) errors.push("package.json still sets private:true");
if (manifest.publishConfig?.access !== "public") {
  errors.push("publishConfig.access must be public");
}
if (manifest.mcpName !== expectedMcpName) {
  errors.push(`package.json mcpName must be ${expectedMcpName}`);
}
if (registryManifest.$schema !== expectedSchema) {
  errors.push(`server.json schema must be ${expectedSchema}`);
}
if (registryManifest.name !== manifest.mcpName) {
  errors.push("server.json name must match package.json mcpName");
}
if (registryManifest.version !== manifest.version) {
  errors.push("server.json version must match package.json version");
}
const registryPackages = Array.isArray(registryManifest.packages) ? registryManifest.packages : [];
if (registryPackages.length !== 1) {
  errors.push("server.json must describe exactly one published package");
}
const registryPackage = registryPackages[0] ?? {};
if (registryPackage.registryType !== "npm") {
  errors.push("server.json package registryType must be npm");
}
if (registryPackage.identifier !== manifest.name) {
  errors.push("server.json npm identifier must match package.json name");
}
if (registryPackage.version !== manifest.version) {
  errors.push("server.json npm version must match package.json version");
}
if (registryPackage.transport?.type !== "stdio") {
  errors.push("server.json package transport must remain stdio");
}

if (manifest.bin?.commerce !== "dist/launch/cli.js") {
  errors.push("commerce bin must target dist/launch/cli.js");
}
if (manifest.bin?.["commerce-mcp"] !== "dist/launch/mcp.js") {
  errors.push("commerce-mcp bin must target dist/launch/mcp.js");
}
const binKeys = Object.keys(manifest.bin ?? {}).sort();
if (JSON.stringify(binKeys) !== JSON.stringify(["commerce", "commerce-mcp"])) {
  errors.push("0.x package must expose exactly commerce and commerce-mcp binaries");
}
const exportKeys = Object.keys(manifest.exports ?? {}).sort();
if (JSON.stringify(exportKeys) !== JSON.stringify(["./package.json"])) {
  errors.push("0.x package must not expose an unsupported JavaScript import API");
}

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "npm pack --dry-run failed\n");
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(`Could not parse npm pack report: ${error}\n`);
  process.exit(1);
}

const packed = report?.[0];
const files = Array.isArray(packed?.files)
  ? packed.files.map((entry) => String(entry.path ?? ""))
  : [];
const fileSet = new Set(files);

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/launch/cli.js",
  "dist/launch/mcp.js",
];

const forbiddenExact = new Set([
  ".gitignore",
  "package-lock.json",
  "tsconfig.json",
  "scripts/install-hermes-commerce-control.sh",
  "scripts/verify-package.mjs",
  "scripts/verify-install.mjs",
  "scripts/check-registry.mjs",
]);
const forbiddenPrefixes = ["src/", "test/", ".github/", "scripts/"];

for (const path of required) {
  if (!fileSet.has(path)) errors.push(`required package file missing: ${path}`);
}
for (const path of files) {
  if (forbiddenExact.has(path)) errors.push(`development-only file packed: ${path}`);
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    errors.push(`development-only path packed: ${path}`);
  }
}

const MAX_PACKED_FILES = 180;
if (files.length > MAX_PACKED_FILES) {
  errors.push(`package contains ${files.length} files; expected <= ${MAX_PACKED_FILES}`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`PACKAGE_BOUNDARY_FAIL: ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      package: `${manifest.name}@${manifest.version}`,
      mcpName: manifest.mcpName,
      registryManifest: {
        schema: registryManifest.$schema,
        name: registryManifest.name,
        version: registryManifest.version,
        registryType: registryPackage.registryType,
        identifier: registryPackage.identifier,
        transport: registryPackage.transport?.type,
      },
      fileCount: files.length,
      unpackedSize: packed?.unpackedSize ?? null,
      packageSize: packed?.size ?? null,
      publicSurface: {
        bins: binKeys,
        javascriptExports: exportKeys,
      },
      required,
    },
    null,
    2,
  ) + "\n",
);
