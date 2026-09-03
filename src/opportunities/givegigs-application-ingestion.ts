import { canonicalHash } from "../core/ids.js";
import type { SafeFetch } from "../network/safe-fetch.js";
import type { HumanFulfillmentContractDraft } from "./human-fulfillment.js";
import {
  createHumanFulfillmentLifecycleEvent,
  type HumanFulfillmentLifecycleEvent,
} from "./human-fulfillment-lifecycle.js";
import { GIVEGIGS_TASKS_ENDPOINT } from "./givegigs-recruitment-transport.js";

const GIVEGIGS_PUBLIC_TASK_ORIGIN = "https://givegigs.com" as const;
const GIVEGIGS_PUBLIC_TASK_PATH_PREFIX = "/ai/gigs/tasks/" as const;
const GIVEGIGS_WORKER_REFERENCE_PREFIX = "givegigs:worker:" as const;

export interface GiveGigsCandidateApplication {
  readonly schemaVersion: 1;
  readonly applicationReference: string;
  readonly taskId: string;
  readonly providerWorkerId: string;
  readonly providerApplicationId?: string | undefined;
  readonly candidateReference: string;
  readonly providerStatus?: string | undefined;
  readonly appliedAt?: string | undefined;
  /** Untrusted applicant-supplied text. It is not copied into lifecycle state automatically. */
  readonly message?: string | undefined;
  readonly boundary: {
    readonly publicReadOnly: true;
    readonly qualificationRequired: true;
    readonly assignmentAllowed: false;
    readonly workerHired: false;
    readonly paymentExecutionAllowed: false;
  };
}

export interface GiveGigsApplicationSnapshot {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly taskReference: string;
  readonly applications: readonly GiveGigsCandidateApplication[];
  readonly skippedApplicationCount: number;
  readonly boundary: {
    readonly publicReadOnly: true;
    readonly authenticatedProviderRead: false;
    readonly providerWriteExecuted: false;
    readonly workerHired: false;
    readonly paymentExecutionAllowed: false;
  };
}

function boundedText(name: string, raw: string, max: number): string {
  const value = raw.trim();
  if (value === "") throw new Error(`${name} must not be empty`);
  if (value.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return value;
}

function optionalText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || value.length > max) return undefined;
  return value;
}

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Readonly<Record<string, unknown>>;
}

function firstOptionalText(values: readonly unknown[], max: number): string | undefined {
  for (const value of values) {
    const normalized = optionalText(value, max);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function validProviderId(name: string, raw: string): string {
  const value = boundedText(name, raw, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

function optionalTimestamp(raw: unknown): string | undefined {
  const value = optionalText(raw, 128);
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

export function giveGigsTaskIdFromReference(rawReference: string): string {
  const reference = boundedText("GiveGigs task reference", rawReference, 2_048);
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new Error("GiveGigs task reference is not a valid URL");
  }
  if (url.origin !== GIVEGIGS_PUBLIC_TASK_ORIGIN || !url.pathname.startsWith(GIVEGIGS_PUBLIC_TASK_PATH_PREFIX)) {
    throw new Error("GiveGigs task reference is outside the expected public task namespace");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("GiveGigs task reference must not contain credentials");
  }
  const remainder = url.pathname.slice(GIVEGIGS_PUBLIC_TASK_PATH_PREFIX.length);
  if (remainder === "" || remainder.includes("/")) {
    throw new Error("GiveGigs task reference must identify exactly one task");
  }
  return validProviderId("GiveGigs task id", remainder);
}

function normalizeTaskReference(rawReference: string, taskId: string): string {
  const url = new URL(boundedText("GiveGigs task reference", rawReference, 2_048));
  url.search = "";
  url.hash = "";
  url.pathname = `${GIVEGIGS_PUBLIC_TASK_PATH_PREFIX}${taskId}`;
  return url.toString();
}

function providerTaskId(body: Readonly<Record<string, unknown>>): string | undefined {
  const task = asRecord(body.task);
  return firstOptionalText(
    [task?.taskId, task?.id, body.taskId, body.id],
    128,
  );
}

function applicationRows(body: Readonly<Record<string, unknown>>): readonly unknown[] {
  const task = asRecord(body.task);
  const raw = task?.applications ?? body.applications;
  if (!Array.isArray(raw)) {
    throw new Error("GiveGigs task detail response does not contain an applications array");
  }
  if (raw.length > 10_000) throw new Error("GiveGigs applications array exceeds safety limit");
  return raw;
}

function workerIdFromApplication(row: Readonly<Record<string, unknown>>): string | undefined {
  const worker = asRecord(row.worker);
  const applicant = asRecord(row.applicant);
  return firstOptionalText(
    [
      row.workerId,
      row.applicantWorkerId,
      worker?.workerId,
      worker?.id,
      applicant?.workerId,
      applicant?.id,
    ],
    128,
  );
}

function normalizeApplication(taskId: string, raw: unknown): GiveGigsCandidateApplication | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const rawWorkerId = workerIdFromApplication(row);
  if (rawWorkerId === undefined) return undefined;

  let providerWorkerId: string;
  try {
    providerWorkerId = validProviderId("GiveGigs worker id", rawWorkerId);
  } catch {
    return undefined;
  }

  const rawProviderApplicationId = firstOptionalText([row.applicationId, row.id], 128);
  let providerApplicationId: string | undefined;
  if (rawProviderApplicationId !== undefined) {
    try {
      providerApplicationId = validProviderId("GiveGigs application id", rawProviderApplicationId);
    } catch {
      providerApplicationId = undefined;
    }
  }

  const providerStatus = optionalText(row.status, 64);
  const appliedAt = optionalTimestamp(row.appliedAt ?? row.createdAt);
  const message = firstOptionalText([row.message, row.note, row.coverLetter], 2_000);
  const candidateReference = `${GIVEGIGS_WORKER_REFERENCE_PREFIX}${providerWorkerId}`;
  const applicationReference = `givegigs:application:${canonicalHash({
    schemaVersion: 1,
    taskId,
    providerWorkerId,
    providerApplicationId: providerApplicationId ?? null,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    applicationReference,
    taskId,
    providerWorkerId,
    ...(providerApplicationId === undefined ? {} : { providerApplicationId }),
    candidateReference,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(appliedAt === undefined ? {} : { appliedAt }),
    ...(message === undefined ? {} : { message }),
    boundary: Object.freeze({
      publicReadOnly: true as const,
      qualificationRequired: true as const,
      assignmentAllowed: false as const,
      workerHired: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Read one GiveGigs task's applications through the shared no-credential safe
 * fetch boundary. Provider/application text is treated as untrusted data and
 * cannot qualify, assign, hire, or authorize payment by itself.
 */
export async function readGiveGigsApplications(
  safeFetch: SafeFetch,
  externalTaskReference: string,
): Promise<GiveGigsApplicationSnapshot> {
  const taskId = giveGigsTaskIdFromReference(externalTaskReference);
  const taskReference = normalizeTaskReference(externalTaskReference, taskId);
  const endpoint = `${GIVEGIGS_TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`;
  const raw = await safeFetch.json<unknown>(endpoint);
  const body = asRecord(raw);
  if (body === undefined || body.success !== true) {
    throw new Error("GiveGigs task detail response did not confirm success");
  }

  const responseTaskId = providerTaskId(body);
  if (responseTaskId !== undefined && validProviderId("GiveGigs response task id", responseTaskId) !== taskId) {
    throw new Error("GiveGigs task detail response does not match requested task");
  }

  const rows = applicationRows(body);
  const applications: GiveGigsCandidateApplication[] = [];
  let skippedApplicationCount = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const application = normalizeApplication(taskId, row);
    if (application === undefined) {
      skippedApplicationCount += 1;
      continue;
    }
    if (seen.has(application.applicationReference)) continue;
    seen.add(application.applicationReference);
    applications.push(application);
  }
  if (rows.length > 0 && applications.length === 0) {
    throw new Error("GiveGigs returned applications but none contained a usable worker identity");
  }

  applications.sort((a, b) =>
    (a.appliedAt ?? "").localeCompare(b.appliedAt ?? "") ||
    a.applicationReference.localeCompare(b.applicationReference));

  return Object.freeze({
    schemaVersion: 1 as const,
    taskId,
    taskReference,
    applications: Object.freeze(applications),
    skippedApplicationCount,
    boundary: Object.freeze({
      publicReadOnly: true as const,
      authenticatedProviderRead: false as const,
      providerWriteExecuted: false as const,
      workerHired: false as const,
      paymentExecutionAllowed: false as const,
    }),
  });
}

/**
 * Create a candidate-specific derivative of the already-frozen recruitment
 * contract. Scope, acceptance criteria, evidence requirements, compensation,
 * deadline, economics, and policy remain unchanged; only worker identity is
 * made concrete from the provider application.
 */
export function bindGiveGigsApplicationToContract(
  template: HumanFulfillmentContractDraft,
  application: GiveGigsCandidateApplication,
): HumanFulfillmentContractDraft {
  if (!template.financial.paymentAuthorizationReady) {
    throw new Error("candidate-specific contract requires the existing worker economics to remain viable");
  }
  const workerReference = boundedText("candidateReference", application.candidateReference, 512);
  const terms = Object.freeze({
    ...template.terms,
    workerReference,
  });
  const contractId = `hcontract_${canonicalHash({
    policyVersion: template.policyVersion,
    recruitmentDraftId: template.recruitmentDraftId,
    terms,
  }).slice(0, 32)}`;

  return Object.freeze({
    ...template,
    contractId,
    terms,
  });
}

/** Record only the durable provider/candidate linkage; raw application text is omitted. */
export function createGiveGigsCandidateRecordedEvent(
  candidateContract: HumanFulfillmentContractDraft,
  application: GiveGigsCandidateApplication,
  observedAt: string,
): HumanFulfillmentLifecycleEvent {
  if (candidateContract.terms.workerReference !== application.candidateReference) {
    throw new Error("candidate contract does not match GiveGigs application worker reference");
  }
  return createHumanFulfillmentLifecycleEvent({
    type: "candidate_recorded",
    opportunityId: candidateContract.opportunityId,
    occurredAt: observedAt,
    contractId: candidateContract.contractId,
    recruitmentDraftId: candidateContract.recruitmentDraftId,
    candidateReference: application.candidateReference,
    externalReference: application.applicationReference,
    note: application.providerStatus === undefined
      ? "GiveGigs application observed"
      : `GiveGigs application observed with provider status ${application.providerStatus}`,
  });
}
