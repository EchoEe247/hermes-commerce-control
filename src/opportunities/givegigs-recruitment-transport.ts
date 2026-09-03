import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalHash, canonicalJson } from "../core/ids.js";
import type { HumanRecruitmentTarget } from "./human-recruitment-adapters.js";
import type {
  HumanRecruitmentTransport,
  HumanRecruitmentTransportInput,
  HumanRecruitmentTransportResult,
} from "./human-recruitment-executor.js";
import { withFileLock } from "./file-lock.js";

export const GIVEGIGS_TASKS_ENDPOINT = "https://givegigs.com/api/ai/tasks" as const;
export const GIVEGIGS_CHANNEL = "marketplace" as const;
export const GIVEGIGS_TARGET_PREFIX = "givegigs:offsite-pay:" as const;

export const GIVEGIGS_URGENCY_LEVELS = ["LOW", "NORMAL", "URGENT", "CRITICAL"] as const;
export type GiveGigsUrgency = (typeof GIVEGIGS_URGENCY_LEVELS)[number];

interface GiveGigsCommonPostingConfig {
  /** Worker-visible way to coordinate after applying. Never put a secret here. */
  readonly contactMethods: string;
  /** Worker-visible off-site payment rail/description. */
  readonly paymentMethod: string;
  readonly clientId?: string | undefined;
  readonly skillsNeeded?: string | undefined;
  readonly urgency?: GiveGigsUrgency | undefined;
  readonly expiresInDays?: number | undefined;
}

export type GiveGigsPostingConfig = GiveGigsCommonPostingConfig &
  (
    | {
        readonly locationType: "REMOTE";
      }
    | {
        readonly locationType: "LOCAL";
        readonly latitude: number;
        readonly longitude: number;
        readonly country: string;
        readonly locationName?: string | undefined;
        readonly locationRadiusKm?: number | null | undefined;
      }
  );

interface NormalizedGiveGigsCommonPostingConfig {
  readonly contactMethods: string;
  readonly paymentMethod: string;
  readonly urgency: GiveGigsUrgency;
  readonly clientId?: string | undefined;
  readonly skillsNeeded?: string | undefined;
  readonly expiresInDays?: number | undefined;
}

type NormalizedGiveGigsPostingConfig = NormalizedGiveGigsCommonPostingConfig &
  (
    | {
        readonly locationType: "REMOTE";
      }
    | {
        readonly locationType: "LOCAL";
        readonly latitude: number;
        readonly longitude: number;
        readonly country: string;
        readonly locationName?: string | undefined;
        readonly locationRadiusKm?: number | null | undefined;
      }
  );

export type GiveGigsApiKeyProvider = () => string | Promise<string>;
export type GiveGigsFetch = typeof fetch;

function boundedText(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} must not be empty`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return normalized;
}

function optionalText(name: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(name, value, max);
}

function normalizePostingConfig(config: GiveGigsPostingConfig): NormalizedGiveGigsPostingConfig {
  const common: NormalizedGiveGigsCommonPostingConfig = Object.freeze({
    contactMethods: boundedText("GiveGigs contactMethods", config.contactMethods, 2_000),
    paymentMethod: boundedText("GiveGigs paymentMethod", config.paymentMethod, 500),
    urgency: config.urgency ?? "NORMAL",
    ...(optionalText("GiveGigs clientId", config.clientId, 256) === undefined
      ? {}
      : { clientId: optionalText("GiveGigs clientId", config.clientId, 256) }),
    ...(optionalText("GiveGigs skillsNeeded", config.skillsNeeded, 1_000) === undefined
      ? {}
      : { skillsNeeded: optionalText("GiveGigs skillsNeeded", config.skillsNeeded, 1_000) }),
    ...(config.expiresInDays === undefined ? {} : { expiresInDays: normalizeExpires(config.expiresInDays) }),
  });

  if (config.locationType === "REMOTE") {
    return Object.freeze({ ...common, locationType: "REMOTE" as const });
  }

  if (!Number.isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
    throw new Error("GiveGigs latitude must be between -90 and 90");
  }
  if (!Number.isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
    throw new Error("GiveGigs longitude must be between -180 and 180");
  }
  const radius = config.locationRadiusKm;
  if (radius !== undefined && radius !== null && (!Number.isFinite(radius) || radius < 0 || radius > 10_000)) {
    throw new Error("GiveGigs locationRadiusKm must be null or between 0 and 10000");
  }
  return Object.freeze({
    ...common,
    locationType: "LOCAL" as const,
    latitude: config.latitude,
    longitude: config.longitude,
    country: boundedText("GiveGigs country", config.country, 128),
    ...(optionalText("GiveGigs locationName", config.locationName, 500) === undefined
      ? {}
      : { locationName: optionalText("GiveGigs locationName", config.locationName, 500) }),
    ...(radius === undefined ? {} : { locationRadiusKm: radius }),
  });
}

function normalizeExpires(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new Error("GiveGigs expiresInDays must be an integer from 1 to 365");
  }
  return value;
}

export function giveGigsPostingBinding(config: GiveGigsPostingConfig): string {
  const normalized = normalizePostingConfig(config);
  return `${GIVEGIGS_TARGET_PREFIX}${canonicalHash({ schemaVersion: 1, posting: normalized }).slice(0, 32)}`;
}

/**
 * Build the generic recruitment target that is bound to the exact non-secret,
 * worker-visible GiveGigs posting configuration. If payment/contact/location
 * configuration changes, the target changes and the old exact B1 intent cannot
 * authorize the new request.
 */
export function buildGiveGigsRecruitmentTarget(
  config: GiveGigsPostingConfig,
  rulesVerifiedAt: string,
): HumanRecruitmentTarget {
  if (!Number.isFinite(Date.parse(rulesVerifiedAt))) throw new Error("rulesVerifiedAt must be a valid timestamp");
  return Object.freeze({
    channel: GIVEGIGS_CHANNEL,
    target: giveGigsPostingBinding(config),
    rulesVerifiedAt,
    delivery: "public_post" as const,
  });
}

const idempotencyEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().min(1).max(128),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    event: z.enum(["claimed", "completed", "released"]),
    occurredAt: z.string().min(1).max(128),
    externalReference: z.string().min(1).max(2_048).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

type GiveGigsIdempotencyEvent = z.infer<typeof idempotencyEventSchema>;

export type GiveGigsIdempotencyClaim =
  | Readonly<{ status: "claimed" }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; externalReference: string }>;

export interface GiveGigsIdempotencyStore {
  claim(idempotencyKey: string, requestHash: string, occurredAt: string): Promise<GiveGigsIdempotencyClaim>;
  complete(
    idempotencyKey: string,
    requestHash: string,
    externalReference: string,
    occurredAt: string,
  ): Promise<void>;
  /** Call only after a definitive response or operator reconciliation proves no external task was created. */
  releaseAfterConfirmedNoMutation(
    idempotencyKey: string,
    requestHash: string,
    reason: string,
    occurredAt: string,
  ): Promise<void>;
}

function validateEventTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("idempotency event timestamp must be valid");
  return value;
}

function validateRequestHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("requestHash must be a canonical 64-character hex hash");
  return value;
}

function stateForKey(
  rows: readonly GiveGigsIdempotencyEvent[],
  idempotencyKey: string,
): GiveGigsIdempotencyEvent | undefined {
  let state: GiveGigsIdempotencyEvent | undefined;
  for (const row of rows) {
    if (row.idempotencyKey !== idempotencyKey) continue;
    if (state === undefined) {
      if (row.event !== "claimed") throw new Error(`invalid GiveGigs idempotency history for ${idempotencyKey}`);
      state = row;
      continue;
    }
    if (state.requestHash !== row.requestHash) {
      throw new Error(`GiveGigs idempotency key ${idempotencyKey} was reused for a different request`);
    }
    if (state.event === "completed") {
      throw new Error(`invalid GiveGigs idempotency history after completed ${idempotencyKey}`);
    }
    if (state.event === "claimed") {
      if (row.event !== "completed" && row.event !== "released") {
        throw new Error(`invalid GiveGigs idempotency transition for ${idempotencyKey}`);
      }
      state = row;
      continue;
    }
    if (state.event === "released") {
      if (row.event !== "claimed") throw new Error(`invalid GiveGigs idempotency transition for ${idempotencyKey}`);
      state = row;
    }
  }
  return state;
}

/**
 * Crash-conservative local idempotency journal. A claim is persisted before the
 * remote POST. If the process loses the outcome after sending, retries stop at
 * `pending` rather than risking a duplicate worker listing. The operator may
 * release that claim only after confirming that no external mutation happened.
 */
export class JsonlGiveGigsIdempotencyStore implements GiveGigsIdempotencyStore {
  public constructor(private readonly path: string) {}

  public async claim(
    rawIdempotencyKey: string,
    rawRequestHash: string,
    rawOccurredAt: string,
  ): Promise<GiveGigsIdempotencyClaim> {
    const idempotencyKey = boundedText("idempotencyKey", rawIdempotencyKey, 128);
    const requestHash = validateRequestHash(rawRequestHash);
    const occurredAt = validateEventTime(rawOccurredAt);
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => {
      await this.repairTailBeforeWrite();
      const rows = await this.readAll();
      const current = stateForKey(rows, idempotencyKey);
      if (current !== undefined && current.requestHash !== requestHash) {
        throw new Error(`GiveGigs idempotency key ${idempotencyKey} was reused for a different request`);
      }
      if (current?.event === "completed") {
        if (current.externalReference === undefined) throw new Error("completed idempotency event lacks externalReference");
        return Object.freeze({ status: "completed" as const, externalReference: current.externalReference });
      }
      if (current?.event === "claimed") return Object.freeze({ status: "pending" as const });
      await this.appendUnlocked(
        idempotencyEventSchema.parse({
          schemaVersion: 1,
          idempotencyKey,
          requestHash,
          event: "claimed",
          occurredAt,
        }),
      );
      return Object.freeze({ status: "claimed" as const });
    });
  }

  public async complete(
    rawIdempotencyKey: string,
    rawRequestHash: string,
    rawExternalReference: string,
    rawOccurredAt: string,
  ): Promise<void> {
    const idempotencyKey = boundedText("idempotencyKey", rawIdempotencyKey, 128);
    const requestHash = validateRequestHash(rawRequestHash);
    const externalReference = boundedText("externalReference", rawExternalReference, 2_048);
    const occurredAt = validateEventTime(rawOccurredAt);
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, async () => {
      await this.repairTailBeforeWrite();
      const rows = await this.readAll();
      const current = stateForKey(rows, idempotencyKey);
      if (current === undefined || current.requestHash !== requestHash) {
        throw new Error(`cannot complete unclaimed GiveGigs idempotency key ${idempotencyKey}`);
      }
      if (current.event === "completed") {
        if (current.externalReference !== externalReference) {
          throw new Error(`completed GiveGigs idempotency key ${idempotencyKey} has a different external reference`);
        }
        return;
      }
      if (current.event !== "claimed") {
        throw new Error(`cannot complete released GiveGigs idempotency key ${idempotencyKey} without reclaiming it`);
      }
      await this.appendUnlocked(
        idempotencyEventSchema.parse({
          schemaVersion: 1,
          idempotencyKey,
          requestHash,
          event: "completed",
          occurredAt,
          externalReference,
        }),
      );
    });
  }

  public async releaseAfterConfirmedNoMutation(
    rawIdempotencyKey: string,
    rawRequestHash: string,
    rawReason: string,
    rawOccurredAt: string,
  ): Promise<void> {
    const idempotencyKey = boundedText("idempotencyKey", rawIdempotencyKey, 128);
    const requestHash = validateRequestHash(rawRequestHash);
    const reason = boundedText("idempotency release reason", rawReason, 500);
    const occurredAt = validateEventTime(rawOccurredAt);
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, async () => {
      await this.repairTailBeforeWrite();
      const rows = await this.readAll();
      const current = stateForKey(rows, idempotencyKey);
      if (current === undefined || current.requestHash !== requestHash || current.event !== "claimed") {
        throw new Error(`GiveGigs idempotency key ${idempotencyKey} is not a releasable pending claim`);
      }
      await this.appendUnlocked(
        idempotencyEventSchema.parse({
          schemaVersion: 1,
          idempotencyKey,
          requestHash,
          event: "released",
          occurredAt,
          reason,
        }),
      );
    });
  }

  private async appendUnlocked(event: GiveGigsIdempotencyEvent): Promise<void> {
    await appendFile(this.path, `${canonicalJson(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async repairTailBeforeWrite(): Promise<void> {
    let body: Buffer;
    try {
      body = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (body.length === 0 || body[body.length - 1] === 0x0a) return;
    const lastNewline = body.lastIndexOf(0x0a);
    const tailStart = lastNewline + 1;
    const tail = body.subarray(tailStart).toString("utf8").trim();
    if (tail !== "") {
      try {
        idempotencyEventSchema.parse(JSON.parse(tail));
        await appendFile(this.path, "\n", { encoding: "utf8" });
        return;
      } catch {
        // Crash-truncated final records are removed before the next claim/write.
      }
    }
    await truncate(this.path, tailStart);
  }

  private async readAll(): Promise<GiveGigsIdempotencyEvent[]> {
    let body: string;
    try {
      body = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: GiveGigsIdempotencyEvent[] = [];
    for (const [index, line] of body.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(idempotencyEventSchema.parse(JSON.parse(trimmed)));
      } catch (error) {
        throw new Error(`corrupt GiveGigs idempotency journal at line ${String(index + 1)}`, { cause: error });
      }
    }
    return out;
  }
}

export interface GiveGigsRecruitmentTransportOptions {
  readonly posting: GiveGigsPostingConfig;
  readonly apiKeyProvider: GiveGigsApiKeyProvider;
  readonly idempotencyStore: GiveGigsIdempotencyStore;
  readonly fetchImpl?: GiveGigsFetch | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly clock?: (() => string) | undefined;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return 15_000;
  if (!Number.isFinite(value) || value < 1_000 || value > 120_000) {
    throw new Error("GiveGigs requestTimeoutMs must be between 1000 and 120000");
  }
  return Math.trunc(value);
}

function exactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("GiveGigs promised compensation must be positive USD");
  const cents = value * 100;
  if (Math.abs(Math.round(cents) - cents) > 1e-9) {
    throw new Error("GiveGigs promised compensation must have at most two decimal places");
  }
  return value.toFixed(2);
}

function safeNoMutationStatus(status: number): boolean {
  return new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 429]).has(status);
}

function validateTaskUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("GiveGigs success response is missing taskUrl");
  const value = boundedText("GiveGigs taskUrl", raw, 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GiveGigs taskUrl is not a valid URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "givegigs.com" || !url.pathname.startsWith("/ai/gigs/tasks/")) {
    throw new Error("GiveGigs taskUrl is outside the expected task namespace");
  }
  return url.toString();
}

function buildTaskBody(
  input: HumanRecruitmentTransportInput,
  posting: NormalizedGiveGigsPostingConfig,
): Readonly<Record<string, unknown>> {
  const title = boundedText("GiveGigs title", input.title, 200);
  const description = boundedText("GiveGigs description", input.body, 5_000);
  if (input.workerTerms.kind === "physical" && posting.locationType !== "LOCAL") {
    throw new Error("physical human recruitment requires a LOCAL GiveGigs posting configuration");
  }
  if (input.workerTerms.kind === "remote" && posting.locationType !== "REMOTE") {
    throw new Error("remote human recruitment requires a REMOTE GiveGigs posting configuration");
  }

  const common = {
    title,
    description,
    fundingType: "OFFSITE_PAY",
    promisedAmount: exactUsd(input.workerTerms.fullCompensationUsd),
    currency: "USD",
    paymentMethod: posting.paymentMethod,
    contactMethods: posting.contactMethods,
    urgency: posting.urgency,
    locationType: posting.locationType,
    ...(posting.clientId === undefined ? {} : { clientId: posting.clientId }),
    ...(posting.skillsNeeded === undefined ? {} : { skillsNeeded: posting.skillsNeeded }),
    ...(posting.expiresInDays === undefined ? {} : { expiresInDays: posting.expiresInDays }),
  };

  if (posting.locationType === "REMOTE") return Object.freeze(common);
  return Object.freeze({
    ...common,
    latitude: posting.latitude,
    longitude: posting.longitude,
    country: posting.country,
    ...(posting.locationName === undefined ? {} : { locationName: posting.locationName }),
    ...(posting.locationRadiusKm === undefined ? {} : { locationRadius: posting.locationRadiusKm }),
  });
}

/**
 * Concrete GiveGigs OFFSITE_PAY public-task transport.
 *
 * The API key is supplied lazily and is never part of the generic CommerceConfig,
 * request hash, idempotency journal, receipt, or error message. The endpoint is
 * fixed so an untrusted marketplace URL cannot redirect the credential elsewhere.
 */
export class GiveGigsHumanRecruitmentTransport implements HumanRecruitmentTransport {
  public readonly channel = GIVEGIGS_CHANNEL;
  private readonly posting: NormalizedGiveGigsPostingConfig;
  private readonly targetBinding: string;
  private readonly apiKeyProvider: GiveGigsApiKeyProvider;
  private readonly idempotencyStore: GiveGigsIdempotencyStore;
  private readonly fetchImpl: GiveGigsFetch;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => string;

  public constructor(options: GiveGigsRecruitmentTransportOptions) {
    this.posting = normalizePostingConfig(options.posting);
    this.targetBinding = giveGigsPostingBinding(options.posting);
    this.apiKeyProvider = options.apiKeyProvider;
    this.idempotencyStore = options.idempotencyStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs);
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public async execute(input: HumanRecruitmentTransportInput): Promise<HumanRecruitmentTransportResult> {
    if (input.action !== "post" || input.delivery !== "public_post") {
      throw new Error("GiveGigs recruitment transport supports public task posts only");
    }
    if (input.target !== this.targetBinding) {
      throw new Error("GiveGigs posting configuration does not match the exact approved recruitment target");
    }
    const taskBody = buildTaskBody(input, this.posting);
    const requestHash = canonicalHash({ method: "POST", endpoint: GIVEGIGS_TASKS_ENDPOINT, body: taskBody });
    const apiKey = boundedText("GiveGigs API key", await this.apiKeyProvider(), 512);
    if (!apiKey.startsWith("givegigs-")) throw new Error("GiveGigs API key has an invalid prefix");

    const claimedAt = this.clock();
    validateEventTime(claimedAt);
    const claim = await this.idempotencyStore.claim(input.idempotencyKey, requestHash, claimedAt);
    if (claim.status === "completed") return Object.freeze({ externalReference: claim.externalReference });
    if (claim.status === "pending") {
      throw new Error(
        "GiveGigs recruitment intent has an unresolved prior POST; reconcile the remote task before retrying to avoid a duplicate listing",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(GIVEGIGS_TASKS_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(taskBody),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        "GiveGigs recruitment POST outcome is ambiguous; the idempotency claim remains pending until remote reconciliation",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (safeNoMutationStatus(response.status)) {
        await this.idempotencyStore.releaseAfterConfirmedNoMutation(
          input.idempotencyKey,
          requestHash,
          `provider returned definitive no-create HTTP ${String(response.status)}`,
          this.clock(),
        );
      }
      throw new Error(`GiveGigs task creation failed with HTTP ${String(response.status)}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) > 1_000_000) {
      throw new Error(
        "GiveGigs success response is unexpectedly large; the idempotency claim remains pending for reconciliation",
      );
    }
    const raw = await response.text();
    if (raw.length > 1_000_000) {
      throw new Error(
        "GiveGigs success response is unexpectedly large; the idempotency claim remains pending for reconciliation",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        "GiveGigs success response is malformed; the idempotency claim remains pending for reconciliation",
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { success?: unknown }).success !== true) {
      throw new Error(
        "GiveGigs success response did not confirm task creation; the idempotency claim remains pending for reconciliation",
      );
    }
    const externalReference = validateTaskUrl((parsed as { taskUrl?: unknown }).taskUrl);
    await this.idempotencyStore.complete(input.idempotencyKey, requestHash, externalReference, this.clock());
    return Object.freeze({ externalReference });
  }
}
