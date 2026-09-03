/**
 * Policy decision shape.
 *
 * A decision is machine-readable, frozen, and JSON-serializable because it is
 * embedded in intents, receipts and MCP responses. Only the policy engine
 * constructs one: the factory functions are module-private by convention and
 * re-exported solely for the engine's use.
 */
import type { ActivationStage, Mode, OperationClass } from "./modes.js";

export type PolicyOutcome = "allow" | "block";

/** Stable block reasons. These strings appear in receipts and handoffs. */
export type PolicyReason =
  | "EXTERNAL_WRITE_DISABLED"
  | "EXTERNAL_WRITE_NOT_AUTHORIZED"
  | "LIVE_VALUE_MOVEMENT_DISABLED"
  | "SECRET_ACCESS_FORBIDDEN"
  | "POLICY_BLOCKED";

export interface PolicyRequest {
  readonly operation: string;
  readonly class: OperationClass;
  /** True when the operation would need a signer or other spending credential. */
  readonly requiresSigner?: boolean | undefined;
  /** True when the operation would move an asset. */
  readonly movesValue?: boolean | undefined;
  /** True when the operation would mutate external state. */
  readonly mutatesExternal?: boolean | undefined;
  /** Exact immutable external-action intent id, when the action is intent-scoped. */
  readonly externalIntentId?: string | undefined;
  readonly network?: string | undefined;
  readonly platform?: string | undefined;
}

export interface PolicyDecision {
  readonly decision: PolicyOutcome;
  readonly rule: string;
  readonly operation: string;
  readonly class: OperationClass | "UNKNOWN";
  readonly mode: Mode;
  readonly reason: PolicyReason | null;
  readonly requiredActivation: ActivationStage | null;
  readonly evaluatedAt: string;
  readonly detail: string;
}

export function allowDecision(input: {
  operation: string;
  class: OperationClass;
  rule: string;
  detail: string;
  evaluatedAt: string;
}): PolicyDecision {
  return Object.freeze({
    decision: "allow" as const,
    rule: input.rule,
    operation: input.operation,
    class: input.class,
    mode: "A" as const,
    reason: null,
    requiredActivation: null,
    evaluatedAt: input.evaluatedAt,
    detail: input.detail,
  });
}

export function blockDecision(input: {
  operation: string;
  class: OperationClass | "UNKNOWN";
  rule: string;
  reason: PolicyReason;
  requiredActivation: ActivationStage | null;
  detail: string;
  evaluatedAt: string;
}): PolicyDecision {
  return Object.freeze({
    decision: "block" as const,
    rule: input.rule,
    operation: input.operation,
    class: input.class,
    mode: "A" as const,
    reason: input.reason,
    requiredActivation: input.requiredActivation,
    evaluatedAt: input.evaluatedAt,
    detail: input.detail,
  });
}
