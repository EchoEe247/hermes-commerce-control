import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalHash, canonicalJson } from "../core/ids.js";
import { withFileLock } from "./file-lock.js";

export const HUMAN_FULFILLMENT_EVENT_TYPES = [
  "recruitment_payload_prepared",
  "external_action_intent_prepared",
  "external_action_executed",
  "candidate_recorded",
  "candidate_qualification_recorded",
  "contract_recorded",
  "assignment_recorded",
  "assignment_decision_recorded",
  "worker_acceptance_recorded",
  "attempt_submitted",
  "attempt_assessed",
  "correction_requested",
  "correction_response_recorded",
  "external_blocker_recorded",
  "replacement_authorized",
  "attempt_evidence_recorded",
  "review_recorded",
  "worker_performance_recorded",
] as const;
export type HumanFulfillmentEventType = (typeof HUMAN_FULFILLMENT_EVENT_TYPES)[number];

export const humanFulfillmentLifecycleEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1).max(128),
    type: z.enum(HUMAN_FULFILLMENT_EVENT_TYPES),
    opportunityId: z.string().min(1).max(128),
    occurredAt: z.string().min(1).max(128),
    contractId: z.string().min(1).max(128).optional(),
    recruitmentDraftId: z.string().min(1).max(128).optional(),
    payloadId: z.string().min(1).max(128).optional(),
    intentId: z.string().min(1).max(128).optional(),
    executionReceiptId: z.string().min(1).max(128).optional(),
    externalReference: z.string().min(1).max(2_048).optional(),
    candidateReference: z.string().min(1).max(512).optional(),
    qualificationId: z.string().min(1).max(128).optional(),
    assignmentId: z.string().min(1).max(128).optional(),
    assignmentDecisionId: z.string().min(1).max(128).optional(),
    attemptId: z.string().min(1).max(128).optional(),
    assessmentId: z.string().min(1).max(128).optional(),
    correctionRequestId: z.string().min(1).max(128).optional(),
    correctionResponseId: z.string().min(1).max(128).optional(),
    blockerId: z.string().min(1).max(128).optional(),
    replacementAuthorizationId: z.string().min(1).max(128).optional(),
    performanceId: z.string().min(1).max(128).optional(),
    evidenceSummary: z.array(z.string().min(1).max(2_000)).max(32).optional(),
    reviewId: z.string().min(1).max(128).optional(),
    note: z.string().max(2_000).optional(),
  })
  .strict();

export type HumanFulfillmentLifecycleEvent = z.infer<typeof humanFulfillmentLifecycleEventSchema>;

export interface CreateHumanFulfillmentLifecycleEventInput {
  readonly type: HumanFulfillmentEventType;
  readonly opportunityId: string;
  readonly occurredAt: string;
  readonly contractId?: string | undefined;
  readonly recruitmentDraftId?: string | undefined;
  readonly payloadId?: string | undefined;
  readonly intentId?: string | undefined;
  readonly executionReceiptId?: string | undefined;
  readonly externalReference?: string | undefined;
  readonly candidateReference?: string | undefined;
  readonly qualificationId?: string | undefined;
  readonly assignmentId?: string | undefined;
  readonly assignmentDecisionId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly assessmentId?: string | undefined;
  readonly correctionRequestId?: string | undefined;
  readonly correctionResponseId?: string | undefined;
  readonly blockerId?: string | undefined;
  readonly replacementAuthorizationId?: string | undefined;
  readonly performanceId?: string | undefined;
  readonly evidenceSummary?: readonly string[] | undefined;
  readonly reviewId?: string | undefined;
  readonly note?: string | undefined;
}

function nonEmpty(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} must not be empty`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return normalized;
}

function optionalText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty("optional lifecycle field", value, max);
}

export function createHumanFulfillmentLifecycleEvent(
  input: CreateHumanFulfillmentLifecycleEventInput,
): HumanFulfillmentLifecycleEvent {
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error("occurredAt must be a valid timestamp");
  const opportunityId = nonEmpty("opportunityId", input.opportunityId, 128);
  const evidenceSummary = input.evidenceSummary?.map((item) => nonEmpty("evidenceSummary item", item, 2_000));
  if ((evidenceSummary?.length ?? 0) > 32) throw new Error("evidenceSummary exceeds 32 items");

  const optional = {
    contractId: optionalText(input.contractId, 128),
    recruitmentDraftId: optionalText(input.recruitmentDraftId, 128),
    payloadId: optionalText(input.payloadId, 128),
    intentId: optionalText(input.intentId, 128),
    executionReceiptId: optionalText(input.executionReceiptId, 128),
    externalReference: optionalText(input.externalReference, 2_048),
    candidateReference: optionalText(input.candidateReference, 512),
    qualificationId: optionalText(input.qualificationId, 128),
    assignmentId: optionalText(input.assignmentId, 128),
    assignmentDecisionId: optionalText(input.assignmentDecisionId, 128),
    attemptId: optionalText(input.attemptId, 128),
    assessmentId: optionalText(input.assessmentId, 128),
    correctionRequestId: optionalText(input.correctionRequestId, 128),
    correctionResponseId: optionalText(input.correctionResponseId, 128),
    blockerId: optionalText(input.blockerId, 128),
    replacementAuthorizationId: optionalText(input.replacementAuthorizationId, 128),
    performanceId: optionalText(input.performanceId, 128),
    reviewId: optionalText(input.reviewId, 128),
  };

  const body = {
    schemaVersion: 1 as const,
    type: input.type,
    opportunityId,
    occurredAt: input.occurredAt,
    ...(optional.contractId === undefined ? {} : { contractId: optional.contractId }),
    ...(optional.recruitmentDraftId === undefined ? {} : { recruitmentDraftId: optional.recruitmentDraftId }),
    ...(optional.payloadId === undefined ? {} : { payloadId: optional.payloadId }),
    ...(optional.intentId === undefined ? {} : { intentId: optional.intentId }),
    ...(optional.executionReceiptId === undefined ? {} : { executionReceiptId: optional.executionReceiptId }),
    ...(optional.externalReference === undefined ? {} : { externalReference: optional.externalReference }),
    ...(optional.candidateReference === undefined ? {} : { candidateReference: optional.candidateReference }),
    ...(optional.qualificationId === undefined ? {} : { qualificationId: optional.qualificationId }),
    ...(optional.assignmentId === undefined ? {} : { assignmentId: optional.assignmentId }),
    ...(optional.assignmentDecisionId === undefined ? {} : { assignmentDecisionId: optional.assignmentDecisionId }),
    ...(optional.attemptId === undefined ? {} : { attemptId: optional.attemptId }),
    ...(optional.assessmentId === undefined ? {} : { assessmentId: optional.assessmentId }),
    ...(optional.correctionRequestId === undefined ? {} : { correctionRequestId: optional.correctionRequestId }),
    ...(optional.correctionResponseId === undefined ? {} : { correctionResponseId: optional.correctionResponseId }),
    ...(optional.blockerId === undefined ? {} : { blockerId: optional.blockerId }),
    ...(optional.replacementAuthorizationId === undefined ? {} : { replacementAuthorizationId: optional.replacementAuthorizationId }),
    ...(optional.performanceId === undefined ? {} : { performanceId: optional.performanceId }),
    ...(evidenceSummary === undefined ? {} : { evidenceSummary }),
    ...(optional.reviewId === undefined ? {} : { reviewId: optional.reviewId }),
    ...(input.note === undefined ? {} : { note: input.note.trim().slice(0, 2_000) }),
  };
  const eventId = `hfevt_${canonicalHash(body).slice(0, 32)}`;
  return humanFulfillmentLifecycleEventSchema.parse({ ...body, eventId });
}

export interface HumanFulfillmentLifecycleStore {
  append(event: HumanFulfillmentLifecycleEvent): Promise<boolean>;
  list(opportunityId?: string): Promise<readonly HumanFulfillmentLifecycleEvent[]>;
}

export class JsonlHumanFulfillmentLifecycleStore implements HumanFulfillmentLifecycleStore {
  public constructor(private readonly path: string) {}

  public async append(event: HumanFulfillmentLifecycleEvent): Promise<boolean> {
    const parsed = humanFulfillmentLifecycleEventSchema.parse(event);
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => {
      await this.repairTailBeforeAppend();
      const rows = await this.readAll();
      if (rows.some((row) => row.eventId === parsed.eventId)) return false;
      await appendFile(this.path, `${canonicalJson(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
      return true;
    });
  }

  public async list(opportunityId?: string): Promise<readonly HumanFulfillmentLifecycleEvent[]> {
    const rows = await this.readAll();
    return rows
      .filter((row) => opportunityId === undefined || row.opportunityId === opportunityId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
  }

  private async repairTailBeforeAppend(): Promise<void> {
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
        humanFulfillmentLifecycleEventSchema.parse(JSON.parse(tail));
        await appendFile(this.path, "\n", { encoding: "utf8" });
        return;
      } catch {
        // Remove only the incomplete/corrupt tail.
      }
    }
    await truncate(this.path, tailStart);
  }

  private async readAll(): Promise<HumanFulfillmentLifecycleEvent[]> {
    let body: string;
    try {
      body = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: HumanFulfillmentLifecycleEvent[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(humanFulfillmentLifecycleEventSchema.parse(JSON.parse(trimmed)));
      } catch {
        // Legacy/corrupt records are ignored rather than poisoning the store.
      }
    }
    return out;
  }
}
