/**
 * Hermes Commerce Control Plane — application metadata.
 *
 * Mode A is compiled in as a frozen constant. There is deliberately no code
 * path in this package that can produce a mode other than "A": activation of
 * external writes (Stage B1) or live value movement (Stage B2) requires a
 * separate design, a separate authorization event, and a code change.
 */
import { readFileSync } from "node:fs";

export const APP_NAME = "hermes-commerce-control" as const;
export const APP_MODE = "A" as const;

interface PackageManifest {
  readonly version?: unknown;
}

function readPackageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;

  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("package.json must contain a non-empty version");
  }

  return manifest.version;
}

/**
 * Runtime version is sourced from the same package.json that npm publishes.
 * This prevents CLI/MCP metadata from drifting when `npm version` updates the
 * package manifest for a release.
 */
export const APP_VERSION = readPackageVersion();

export interface AppMetadata {
  readonly name: typeof APP_NAME;
  readonly version: typeof APP_VERSION;
  readonly mode: typeof APP_MODE;
}

/** Returns the frozen Mode-A identity of this control plane. */
export function buildAppMetadata(): AppMetadata {
  return Object.freeze({
    name: APP_NAME,
    version: APP_VERSION,
    mode: APP_MODE,
  });
}
