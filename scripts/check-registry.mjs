#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const expectedRepository = "github.com/echoee247/hermes-commerce-control";

function normalizeRepository(value) {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : value.url;
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function fail(message) {
  process.stderr.write(`REGISTRY_GATE_FAIL: ${message}\n`);
  process.exit(1);
}

const encodedName = encodeURIComponent(manifest.name);
const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(20_000),
});

if (response.status === 404) {
  process.stdout.write(
    JSON.stringify({ ok: true, name: manifest.name, status: "available" }, null, 2) + "\n",
  );
  process.exit(0);
}

if (!response.ok) {
  fail(`npm registry returned HTTP ${response.status} for ${manifest.name}`);
}

const registry = await response.json();
const latestVersion = registry?.["dist-tags"]?.latest;
const latestManifest = latestVersion ? registry?.versions?.[latestVersion] : undefined;
const repositories = [registry?.repository, latestManifest?.repository]
  .map(normalizeRepository)
  .filter(Boolean);
const owned = repositories.some((repository) => repository.includes(expectedRepository));

if (!owned) {
  fail(
    `package name ${manifest.name} already exists but does not identify ${expectedRepository}; ` +
      `registry repositories: ${repositories.join(", ") || "<none>"}`,
  );
}

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      name: manifest.name,
      status: "owned",
      latestVersion: latestVersion ?? null,
      repositories,
    },
    null,
    2,
  ) + "\n",
);
