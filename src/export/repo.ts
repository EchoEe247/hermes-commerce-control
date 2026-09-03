/**
 * Repository exporters.
 *
 * Turns persisted canonical state into reviewable, explicitly non-authoritative
 * legacy analytics snapshots. Three properties are load-bearing:
 *
 *  1. Deterministic bytes. Keys are sorted at every depth and the payload is
 *     pretty-printed, so re-exporting unchanged state produces an identical file.
 *  2. Sanitized content. Every payload passes through the canonical sanitizer
 *     before serialization.
 *  3. Real checksums. Each artifact reports its actual SHA-256 and byte count.
 *
 * These outputs deliberately avoid `state/` and `*-latest` names. Repository
 * current-state authority lives only in docs/CURRENT_STATE.md + state/CURRENT.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_MODE, APP_NAME, APP_VERSION } from "../app.js";
import type { CommerceConfig } from "../config.js";
import { CommerceError } from "../core/errors.js";
import { canonicalJson, sha256Hex } from "../core/ids.js";
import { PLATFORM_IDS, type PlatformId, type ProbeResult } from "../core/models.js";
import { sanitize } from "../evidence/sanitize.js";
import type { CommerceRepository } from "../state/repository.js";

export interface ExportArtifact {
  /** Repository-relative path, always POSIX-style. */
  readonly path: string;
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly exportedAt: string;
}

export const EXPORT_PATHS = Object.freeze({
  services: "analytics/commerce-control/legacy/services-snapshot.json",
  work: "analytics/commerce-control/legacy/work-snapshot.json",
  sourceHealth: "analytics/commerce-control/legacy/source-health-snapshot.json",
  status: "analytics/commerce-control/legacy/status-snapshot.json",
});

/** Keys whose 64-hex values are locally computed digests, not secrets. */
const DIGEST_KEYS: ReadonlySet<string> = new Set([
  "hash",
  "sha256",
  "manifestHash",
  "digest",
]);

const DIGEST_VALUE = /^[0-9a-f]{64}$/;

const EXPORT_FORBIDDEN_VALUES: readonly RegExp[] = Object.freeze([
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/,
  /\b0x[0-9a-fA-F]{64}\b/,
  /nostr\+walletconnect:\/\//i,
  /\b(?:sk|rk|ak|pk)_(?:live|test|prod)?_?[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\b(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|WALLET_SECRET|SIGNING_KEY)\s*=/i,
]);

function restoreDigests(clean: unknown, raw: unknown, key?: string): unknown {
  if (
    key !== undefined &&
    DIGEST_KEYS.has(key) &&
    typeof raw === "string" &&
    DIGEST_VALUE.test(raw)
  ) {
    return raw;
  }
  if (Array.isArray(clean)) {
    const rawArray = Array.isArray(raw) ? raw : [];
    return clean.map((item, index) => restoreDigests(item, rawArray[index], key));
  }
  if (clean !== null && typeof clean === "object") {
    const cleanRecord = clean as Record<string, unknown>;
    const rawRecord = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const entryKey of Object.keys(cleanRecord)) {
      out[entryKey] = restoreDigests(cleanRecord[entryKey], rawRecord[entryKey], entryKey);
    }
    return out;
  }
  return clean;
}

/** Sanitizes a payload for export, preserving locally computed digests. */
export function sanitizeForExport(value: unknown): unknown {
  return restoreDigests(sanitize(value), value);
}

/** Deterministic, human-reviewable serialization: sorted keys, pretty printed. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)) as unknown, null, 2)}\n`;
}

function assertExportable(relativePath: string, text: string): void {
  if (relativePath.startsWith("state/") || /(?:^|\/)[^/]+-latest\.json$/i.test(relativePath)) {
    throw new CommerceError(
      "STATE_ERROR",
      `refusing authoritative-looking legacy export path ${relativePath}`,
      { path: relativePath },
    );
  }
  for (const pattern of EXPORT_FORBIDDEN_VALUES) {
    if (pattern.test(text)) {
      throw new CommerceError(
        "SECRET_ACCESS_FORBIDDEN",
        `refusing to write ${relativePath}: content matched a forbidden secret shape`,
        { path: relativePath },
      );
    }
  }
}

/** Sanitizes, serializes, guards and writes one artifact. */
export function writeArtifact(
  repoRoot: string,
  relativePath: string,
  kind: string,
  payload: unknown,
  exportedAt: string,
): ExportArtifact {
  const text = stableJson(sanitizeForExport(payload));
  assertExportable(relativePath, text);

  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");

  return Object.freeze({
    path: relativePath,
    kind,
    sha256: sha256Hex(text),
    bytes: Buffer.byteLength(text, "utf8"),
    exportedAt,
  });
}

export interface ExportInput {
  readonly config: CommerceConfig;
  readonly repo: CommerceRepository;
  readonly exportedAt: string;
}

const LIST_LIMIT = 10_000;

function latestProbes(repo: CommerceRepository): Map<PlatformId, ProbeResult | null> {
  const map = new Map<PlatformId, ProbeResult | null>();
  for (const platform of PLATFORM_IDS) {
    const probes = repo.listProbes(platform, 1);
    map.set(platform, probes[0] ?? null);
  }
  return map;
}

/** Writes every non-authoritative legacy analytics output. */
export function exportRepositoryOutputs(input: ExportInput): ExportArtifact[] {
  const { config, repo, exportedAt } = input;
  const services = repo.listServices(LIST_LIMIT);
  const work = repo.listWork(LIST_LIMIT);
  const intents = repo.listIntents(LIST_LIMIT);
  const probes = latestProbes(repo);

  const header = {
    tool: APP_NAME,
    version: APP_VERSION,
    mode: APP_MODE,
    generatedAt: exportedAt,
    authority: false,
    financialActionExecuted: false,
    externalMutationExecuted: false,
  };

  const artifacts: ExportArtifact[] = [];

  artifacts.push(
    writeArtifact(
      config.repoRoot,
      EXPORT_PATHS.services,
      "normalized_services",
      { ...header, count: services.length, services },
      exportedAt,
    ),
  );

  artifacts.push(
    writeArtifact(
      config.repoRoot,
      EXPORT_PATHS.work,
      "normalized_work",
      { ...header, count: work.length, work },
      exportedAt,
    ),
  );

  artifacts.push(
    writeArtifact(
      config.repoRoot,
      EXPORT_PATHS.sourceHealth,
      "source_health",
      {
        ...header,
        sources: PLATFORM_IDS.map((platform) => {
          const probe = probes.get(platform) ?? null;
          return {
            platform,
            enabled: config.adapters[platform].enabled,
            baseUrl: config.adapters[platform].baseUrl,
            lastProbe:
              probe === null
                ? null
                : {
                    status: probe.status,
                    checkedAt: probe.checkedAt,
                    latencyMs: probe.latencyMs ?? null,
                    errorCode: probe.errorCode ?? null,
                    detail: probe.detail ?? null,
                  },
          };
        }),
      },
      exportedAt,
    ),
  );

  artifacts.push(
    writeArtifact(
      config.repoRoot,
      EXPORT_PATHS.status,
      "status",
      {
        ...header,
        externalWritesEnabled: false,
        liveValueMovementEnabled: false,
        counts: {
          services: services.length,
          work: work.length,
          intents: intents.length,
        },
        intentOutcomes: countBy(intents.map((intent) => intent.decisionOutcome)),
        adapters: PLATFORM_IDS.map((platform) => ({
          platform,
          enabled: config.adapters[platform].enabled,
          lastStatus: probes.get(platform)?.status ?? null,
        })),
      },
      exportedAt,
    ),
  );

  for (const artifact of artifacts) repo.saveExport(artifact);
  return artifacts;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of [...values].sort()) out[value] = (out[value] ?? 0) + 1;
  return out;
}
