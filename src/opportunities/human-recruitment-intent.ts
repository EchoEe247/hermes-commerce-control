import type { CommerceConfig } from "../config.js";
import { canonicalHash } from "../core/ids.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyDecision } from "../policy/decisions.js";
import type { HumanRecruitmentPayload } from "./human-recruitment-adapters.js";

export interface HumanRecruitmentActionIntent {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly payloadId: string;
  readonly contractId: string;
  readonly opportunityId: string;
  readonly channel: HumanRecruitmentPayload["channel"];
  readonly target: string;
  readonly action: "post" | "contact";
  readonly createdAt: string;
  readonly decision: PolicyDecision;
  readonly boundary: {
    readonly operatorApprovalRequired: true;
    readonly externalMutationExecuted: false;
    readonly compensationExecutionAllowed: false;
  };
}

function actionFor(payload: HumanRecruitmentPayload): "post" | "contact" {
  return payload.delivery === "private_message" ? "contact" : "post";
}

function recruitmentIntentId(
  payload: HumanRecruitmentPayload,
  action: "post" | "contact",
): string {
  return `hintent_${canonicalHash({
    schemaVersion: 1,
    payloadId: payload.payloadId,
    contractId: payload.contractId,
    opportunityId: payload.opportunityId,
    action,
    channel: payload.channel,
    target: payload.target,
  }).slice(0, 32)}`;
}

/**
 * Prepare the exact external recruitment action and ask the central policy
 * engine whether it may execute.
 *
 * The intent id deliberately excludes the policy decision. That lets an
 * operator prepare the intent in the default blocked state, explicitly approve
 * that exact id, and then re-evaluate the same immutable action under the scoped
 * recruitment B1 gate without producing a different id.
 */
export function createHumanRecruitmentActionIntent(
  config: CommerceConfig,
  payload: HumanRecruitmentPayload,
  clock: () => string = (): string => new Date().toISOString(),
): HumanRecruitmentActionIntent {
  if (payload.boundary.externalActionsAllowed !== false) {
    throw new Error("human recruitment payload must remain preparation-only");
  }
  const createdAt = clock();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("intent clock must return a valid timestamp");
  const action = actionFor(payload);
  const intentId = recruitmentIntentId(payload, action);
  const decision = evaluatePolicy(
    config,
    {
      operation: action === "contact" ? "human_recruitment_contact" : "human_recruitment_post",
      class: "EXTERNAL_WRITE",
      platform: `human_recruitment:${payload.channel}`,
      mutatesExternal: true,
      externalIntentId: intentId,
    },
    new Date(createdAt),
  );

  return Object.freeze({
    schemaVersion: 1 as const,
    intentId,
    payloadId: payload.payloadId,
    contractId: payload.contractId,
    opportunityId: payload.opportunityId,
    channel: payload.channel,
    target: payload.target,
    action,
    createdAt,
    decision,
    boundary: Object.freeze({
      operatorApprovalRequired: true as const,
      externalMutationExecuted: false as const,
      compensationExecutionAllowed: false as const,
    }),
  });
}
