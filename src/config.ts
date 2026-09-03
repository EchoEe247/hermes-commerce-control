/**
 * Immutable Commerce Control configuration.
 *
 * The default posture remains Mode A. A narrowly scoped B1 recruitment grant
 * may be enabled for exactly one prepared human-recruitment intent. This does
 * not enable general external writes and never enables live value movement.
 *
 * No field of this config ever holds a secret *value*. Adapters that would need
 * credentials declare an environment-variable *name* only. The denylist below
 * documents the classes of environment variable this process must never copy
 * into its own state.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PLATFORM_IDS, type PlatformId } from "./core/models.js";
import { CommerceError } from "./core/errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Environment-variable name fragments that may never be read into config,
 * persisted, logged, exported or hashed by this control plane.
 */
export const SECRET_ENV_DENYLIST: readonly string[] = Object.freeze([
  "PRIVATE_KEY",
  "PRIVATEKEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "SEED",
  "NWC",
  "WALLET_SECRET",
  "SIGNING_KEY",
  "SECRET",
  "TOKEN",
  "API_KEY",
  "APIKEY",
  "PASSWORD",
  "PASSPHRASE",
  "SESSION",
  "COOKIE",
  "AUTHORIZATION",
  "CREDENTIAL",
  "ACCESS_KEY",
  "REFRESH_TOKEN",
]);

export interface NetworkBounds {
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly adapterBudgetMs: number;
  readonly maxRetries: number;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
}

export interface AdapterConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  /**
   * Name of an environment variable that a *future* authenticated mode would
   * read. The value is never loaded here.
   */
  readonly credentialEnvVar?: string | undefined;
}

export interface HumanRecruitmentActivationConfig {
  readonly enabled: boolean;
  readonly approvedIntentId: string | null;
}

export interface CommerceConfig {
  readonly mode: "A";
  /** General external writes remain disabled even when a scoped recruitment grant is active. */
  readonly externalWritesEnabled: false;
  readonly liveValueMovementEnabled: false;
  readonly humanRecruitmentActivation: HumanRecruitmentActivationConfig;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly cacheRoot: string;
  readonly logRoot: string;
  readonly repoRoot: string;
  readonly concurrency: number;
  readonly network: NetworkBounds;
  readonly adapters: Readonly<Record<PlatformId, AdapterConfig>>;
}

/** Recognized false spellings. Everything else that is present is "truthy". */
const FALSE_TOKENS = new Set(["false", "0", "no", "off", "disabled", ""]);

function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !FALSE_TOKENS.has(raw.trim().toLowerCase());
}

function optionalHumanRecruitmentIntentId(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  if (!/^hintent_[0-9a-f]{32}$/.test(value)) {
    throw new CommerceError(
      "CONFIG_ERROR",
      "HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID must be an exact prepared hintent_<32 hex> id.",
      { gate: "HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID" },
    );
  }
  return value;
}

const DEFAULT_BASE_URLS: Readonly<Record<PlatformId, string>> = Object.freeze({
  cdp_bazaar: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/",
  agent402: "https://agent402.tools/",
  piprail: "https://piprail.com/",
  agent_bounties: "https://api.agentbounties.app/",
  bountybook: "https://www.bountybook.ai/",
  the402: "https://api.the402.ai/",
  paysh: "https://pay.sh/",
});

/**
 * Loads configuration from an explicit environment map.
 *
 * Taking the env as a parameter (rather than reading `process.env` internally)
 * keeps the loader pure and lets the contract tests prove gate behaviour
 * without mutating global state.
 */
export function loadConfig(env: Env = process.env): CommerceConfig {
  const mode = (env.COMMERCE_MODE ?? "A").trim();
  if (mode !== "A") {
    throw new CommerceError(
      "CONFIG_ERROR",
      `only Mode A is implemented; refusing to run in mode ${JSON.stringify(mode)}. ` +
        "Scoped human recruitment uses a separate exact-intent B1 grant rather than enabling a general mode.",
      { requestedMode: mode },
    );
  }

  if (isTruthy(env.EXTERNAL_WRITES_ENABLED)) {
    throw new CommerceError(
      "CONFIG_ERROR",
      "EXTERNAL_WRITES_ENABLED cannot be enabled in Mode A. General external writes remain disabled; " +
        "human recruitment uses the exact-intent HUMAN_RECRUITMENT_B1_* gate.",
      { gate: "EXTERNAL_WRITES_ENABLED" },
    );
  }
  if (isTruthy(env.LIVE_VALUE_MOVEMENT_ENABLED)) {
    throw new CommerceError(
      "CONFIG_ERROR",
      "LIVE_VALUE_MOVEMENT_ENABLED cannot be enabled in Mode A. Live value movement is a " +
        "Stage B2 capability and is not implemented.",
      { gate: "LIVE_VALUE_MOVEMENT_ENABLED" },
    );
  }

  const recruitmentEnabled = isTruthy(env.HUMAN_RECRUITMENT_B1_ENABLED);
  const approvedIntentId = optionalHumanRecruitmentIntentId(
    env.HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID,
  );
  if (recruitmentEnabled && approvedIntentId === null) {
    throw new CommerceError(
      "CONFIG_ERROR",
      "HUMAN_RECRUITMENT_B1_ENABLED requires HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID. " +
        "The grant must be scoped to one already-prepared recruitment intent.",
      { gate: "HUMAN_RECRUITMENT_B1_ENABLED" },
    );
  }
  if (!recruitmentEnabled && approvedIntentId !== null) {
    throw new CommerceError(
      "CONFIG_ERROR",
      "HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID is set while HUMAN_RECRUITMENT_B1_ENABLED is disabled. " +
        "Refusing ambiguous stale authorization state.",
      { gate: "HUMAN_RECRUITMENT_B1_APPROVED_INTENT_ID" },
    );
  }

  const stateRoot = resolve(
    env.COMMERCE_STATE_ROOT?.trim() || join(homedir(), ".hermes", "commerce-control"),
  );
  const repoRoot = resolve(env.COMMERCE_REPO_ROOT?.trim() || process.cwd());

  const concurrency = clampInt(env.COMMERCE_CONCURRENCY, 3, 1, 8);

  const network: NetworkBounds = Object.freeze({
    connectTimeoutMs: clampInt(env.COMMERCE_CONNECT_TIMEOUT_MS, 5_000, 500, 60_000),
    requestTimeoutMs: clampInt(env.COMMERCE_REQUEST_TIMEOUT_MS, 15_000, 1_000, 120_000),
    adapterBudgetMs: clampInt(env.COMMERCE_ADAPTER_BUDGET_MS, 30_000, 1_000, 300_000),
    maxRetries: clampInt(env.COMMERCE_MAX_RETRIES, 2, 0, 5),
    maxRedirects: clampInt(env.COMMERCE_MAX_REDIRECTS, 5, 0, 10),
    maxResponseBytes: clampInt(
      env.COMMERCE_MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      1024,
      64 * 1024 * 1024,
    ),
  });

  const adapters = Object.freeze(
    Object.fromEntries(
      PLATFORM_IDS.map((id) => {
        const disableVar = `COMMERCE_DISABLE_${id.toUpperCase()}`;
        const baseUrlVar = `COMMERCE_${id.toUpperCase()}_BASE_URL`;
        const override = env[baseUrlVar]?.trim();
        const baseUrl = override && override.startsWith("https://") ? override : DEFAULT_BASE_URLS[id];
        return [
          id,
          Object.freeze({
            enabled: !isTruthy(env[disableVar]),
            baseUrl,
          } satisfies AdapterConfig),
        ];
      }),
    ),
  ) as Readonly<Record<PlatformId, AdapterConfig>>;

  return Object.freeze({
    mode: "A" as const,
    externalWritesEnabled: false as const,
    liveValueMovementEnabled: false as const,
    humanRecruitmentActivation: Object.freeze({
      enabled: recruitmentEnabled,
      approvedIntentId,
    }),
    stateRoot,
    databasePath: join(stateRoot, "state.db"),
    cacheRoot: join(stateRoot, "cache"),
    logRoot: join(stateRoot, "logs"),
    repoRoot,
    concurrency,
    network,
    adapters,
  });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * True when an environment-variable name looks secret-bearing.
 * Used by the doctor and the sanitizer, not to read the value.
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV_DENYLIST.some((needle) => upper.includes(needle));
}
