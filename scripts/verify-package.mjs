#!/usr/bin/env node

import { spawnSync } from "node:child_process";

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
  "dist/launch/cli.js",
  "dist/launch/mcp.js",
  "scripts/install-hermes-commerce-control.sh",
];

const forbiddenExact = new Set([
  ".gitignore",
  "package-lock.json",
  "tsconfig.json",
  "scripts/verify-package.mjs",
]);
const forbiddenPrefixes = ["src/", "test/", ".github/"];

const errors = [];
for (const path of required) {
  if (!fileSet.has(path)) errors.push(`required package file missing: ${path}`);
}
for (const path of files) {
  if (forbiddenExact.has(path)) errors.push(`development-only file packed: ${path}`);
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    errors.push(`development-only path packed: ${path}`);
  }
}

// HCC currently compiles a broad but bounded runtime tree. A sudden jump above
// this ceiling is a release-boundary regression and should be reviewed rather
// than silently shipped.
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
      fileCount: files.length,
      unpackedSize: packed?.unpackedSize ?? null,
      packageSize: packed?.size ?? null,
      required,
    },
    null,
    2,
  ) + "\n",
);
