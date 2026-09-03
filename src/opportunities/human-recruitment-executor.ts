import type { CommerceConfig } from "../config.js";
import { canonicalHash } from "../core/ids.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { HumanRecruitmentPayload } from "./human-recruitment-adapters.js";
import type { HumanRecruitmentActionIntent } from "./human-recruitment-intent.js";

const MAX_RULE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface HumanRecruitmentTransportInput {
  readonly idempotencyKey: string;
  readonly action: "post" | "contact";
  readonly target: string;
  readonly delivery: HumanRecruitmentPayload["delivery"];
  /** Frozen worker-visible terms only; upstream payout/internal margin remain absent. */
  readonly workerTerms: HumanRecruitmentPayload["workerTerms"];
  readonly title: string;
  readonly body: string;
}

export interface HumanRecruitmentTransportResult {
  /** Provider/community-specific immutable or durable reference when available. */
  readonly externalReference: string;
}

/**
 * A real provider transport lives outside the policy decision. It must honor
 * `idempotencyKey` so retrying one approved intent cannot create duplicate
 * worker posts/messages.
 */
export interface HumanRecruitmentTransport {
  readonly channel: HumanRecruitmentPayload["channel"];
  execute(input: HumanRecruitmentTransportInput): Promise<HumanRecruitmentTransportResult>;
}

export interface HumanRecruitmentExecutionReceipt {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly intentId: string;
  readonly payloadId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly channel: HumanRecruitmentPayload["channel"];
  readonly target: string;
  readonly action: "post" | "contact";
  readonly externalReference: string;
  readonly executedAt: string;
  readonly policyRule: "B1_HUMAN_RECRUITMENT_EXACT_INTENT";
  readonly boundary: {
    readonly externalMutationExecuted: true;
    readonly compensationExecutionAllowed: false;
    readonly liveValueMovementExecuted: false;
  };
}

function nonEmpty(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} must not be empty`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return normalized;
}

function assertIntentMatchesPayload(
  intent: HumanRecruitmentActionIntent,
  payload: HumanRecruitmentPayload,
): void {
  if (intent.payloadId !== payload.payloadId) throw new Error("intent payloadId does not match payload");
  if (intent.contractId !== payload.contractId) throw new Error("intent contractId does not match payload");
  if (intent.opportunityId !== payload.opportunityId) throw new Error("intent opportunityId does not match payload");
  if (intent.channel !== payload.channel) throw new Error("intent channel does not match payload");
  if (intent.target !== payload.target) throw new Error("intent target does not match payload");
  const expectedAction = payload.delivery === "private_message" ? "contact" : "post";
  if (intent.action !== expectedAction) throw new Error("intent action does not match payload delivery");
}

function assertFreshRules(payload: HumanRecruitmentPayload, executedAt: string): void {
  const verifiedMs = Date.parse(payload.rulesVerifiedAt);
  const executedMs = Date.parse(executedAt);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(executedMs)) {
    throw new Error("recruitment rule/execution timestamps must be valid");
  }
  if (verifiedMs > executedMs) throw new Error("recruitment rules verification cannot be in the future");
  if (executedMs - verifiedMs > MAX_RULE_AGE_MS) {
    throw new Error("recruitment target rules verification is older than seven days; re-verify before execution");
  }
}

/**
 * Execute exactly one already-prepared worker recruitment post/contact through
 * an injected provider transport.
 *
 * The central policy engine is re-evaluated at execution time. A stale intent
 * that was prepared while blocked may execute only if its exact immutable id is
 * now the configured scoped B1 grant. No signer, wallet or compensation path is
 * accepted by this boundary.
 */
export async function executeHumanRecruitmentAction(
  config: CommerceConfig,
  payload: HumanRecruitmentPayload,
  intent: HumanRecruitmentActionIntent,
  transport: HumanRecruitmentTransport,
  clock: () => string = (): string => new Date().toISOString(),
): Promise<HumanRecruitmentExecutionReceipt> {
  assertIntentMatchesPayload(intent, payload);
  if (transport.channel !== payload.channel) throw new Error("transport channel does not match payload channel");

  const executedAt = clock();
  if (!Number.isFinite(Date.parse(executedAt))) throw new Error("execution clock must return a valid timestamp");
  assertFreshRules(payload, executedAt);

  const decision = evaluatePolicy(
    config,
    {
      operation: intent.action === "contact" ? "human_recruitment_contact" : "human_recruitment_post",
      class: "EXTERNAL_WRITE",
      platform: `human_recruitment:${payload.channel}`,
      mutatesExternal: true,
      externalIntentId: intent.intentId,
    },
    new Date(executedAt),
  );
  if (decision.decision !== "allow" || decision.rule !== "B1_HUMAN_RECRUITMENT_EXACT_INTENT") {
    throw new Error(`human recruitment execution blocked by ${decision.rule}: ${decision.reason ?? "POLICY_BLOCKED"}`);
  }

  const result = await transport.execute({
    idempotencyKey: intent.intentId,
    action: intent.action,
    target: payload.target,
    delivery: payload.delivery,
    workerTerms: payload.workerTerms,
    title: payload.rendered.title,
    body: payload.rendered.body,
  });
  const externalReference = nonEmpty("externalReference", result.externalReference, 2_048);
  const receiptId = `hreceipt_${canonicalHash({
    schemaVersion: 1,
    intentId: intent.intentId,
    payloadId: payload.payloadId,
    externalReference,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    receiptId,
    intentId: intent.intentId,
    payloadId: payload.payloadId,
    contractId: payload.contractId,
    opportunityId: payload.opportunityId,
    channel: payload.channel,
    target: payload.target,
    action: intent.action,
    externalReference,
    executedAt,
    policyRule: "B1_HUMAN_RECRUITMENT_EXACT_INTENT" as const,
    boundary: Object.freeze({
      externalMutationExecuted: true as const,
      compensationExecutionAllowed: false as const,
      liveValueMovementExecuted: false as const,
    }),
  });
}