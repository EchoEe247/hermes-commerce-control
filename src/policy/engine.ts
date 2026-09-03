/**
 * The central fail-closed policy engine.
 *
 * Design rules enforced here:
 *
 *  - Only this module produces a final PolicyDecision. Adapters, the intent
 *    engine, the CLI and the MCP server all call in; none of them decides.
 *  - Dangerous *attributes* dominate the declared class. An operation that
 *    claims to be READ but requests a signer is blocked, so a mislabelled or
 *    hostile callsite cannot launder a dangerous action through a safe class.
 *  - General external writes remain disabled. The only B1 slice currently
 *    represented is an exact-intent human-recruitment grant bound in config.
 *  - An unrecognized class fails closed.
 */
import type { CommerceConfig } from "../config.js";
import { CommerceError } from "../core/errors.js";
import {
  allowDecision,
  blockDecision,
  type PolicyDecision,
  type PolicyRequest,
} from "./decisions.js";
import { OPERATION_CLASSES, type OperationClass } from "./modes.js";

const KNOWN_CLASSES = new Set<string>(OPERATION_CLASSES);
const HUMAN_RECRUITMENT_EXTERNAL_OPERATIONS = new Set([
  "human_recruitment_post",
  "human_recruitment_contact",
]);

function exactHumanRecruitmentGrantMatches(
  config: CommerceConfig,
  request: PolicyRequest,
  operation: string,
  cls: OperationClass,
): boolean {
  const activation = config.humanRecruitmentActivation;
  if (!activation.enabled) return false;
  if (cls !== "EXTERNAL_WRITE") return false;
  if (!HUMAN_RECRUITMENT_EXTERNAL_OPERATIONS.has(operation)) return false;
  if (typeof request.platform !== "string" || !request.platform.startsWith("human_recruitment:")) {
    return false;
  }
  return (
    typeof request.externalIntentId === "string" &&
    request.externalIntentId === activation.approvedIntentId
  );
}

/** Evaluates a request against fail-closed Commerce Control policy. Never throws for a block. */
export function evaluatePolicy(
  config: CommerceConfig,
  request: PolicyRequest,
  now: Date = new Date(),
): PolicyDecision {
  const evaluatedAt = now.toISOString();
  const operation = String(request.operation ?? "unknown");
  const declared = request.class as string;

  // Fail closed on an unknown class before looking at anything else.
  if (!KNOWN_CLASSES.has(declared)) {
    return blockDecision({
      operation,
      class: "UNKNOWN",
      rule: "A_MODE_UNKNOWN_OPERATION_CLASS",
      reason: "POLICY_BLOCKED",
      requiredActivation: null,
      detail: `operation class ${JSON.stringify(declared)} is not recognized; failing closed`,
      evaluatedAt,
    });
  }
  const cls = declared as OperationClass;

  // Dangerous attributes override the declared class. Order matters: secret
  // access is the most severe because it is never unlocked by any stage.
  if (request.requiresSigner === true || cls === "SECRET_ACCESS") {
    return blockDecision({
      operation,
      class: cls,
      rule: "A_MODE_SECRET_ACCESS",
      reason: "SECRET_ACCESS_FORBIDDEN",
      requiredActivation: null,
      detail:
        "this control plane never reads, imports, derives or holds a private key, mnemonic, " +
        "seed, NWC string or other signing credential",
      evaluatedAt,
    });
  }

  if (request.movesValue === true || cls === "VALUE_MOVEMENT") {
    return blockDecision({
      operation,
      class: cls,
      rule: "A_MODE_VALUE_MOVEMENT",
      reason: "LIVE_VALUE_MOVEMENT_DISABLED",
      requiredActivation: "B2",
      detail:
        `live value movement is disabled (liveValueMovementEnabled=${String(
          config.liveValueMovementEnabled,
        )}); Stage B2 is not implemented`,
      evaluatedAt,
    });
  }

  if (request.mutatesExternal === true || cls === "EXTERNAL_WRITE") {
    if (exactHumanRecruitmentGrantMatches(config, request, operation, cls)) {
      return allowDecision({
        operation,
        class: cls,
        rule: "B1_HUMAN_RECRUITMENT_EXACT_INTENT",
        detail:
          "external recruitment is authorized for exactly the configured prepared intent; " +
          "general external writes and all value movement remain disabled",
        evaluatedAt,
      });
    }

    if (
      config.humanRecruitmentActivation.enabled &&
      HUMAN_RECRUITMENT_EXTERNAL_OPERATIONS.has(operation)
    ) {
      return blockDecision({
        operation,
        class: cls,
        rule: "B1_HUMAN_RECRUITMENT_EXACT_INTENT",
        reason: "EXTERNAL_WRITE_NOT_AUTHORIZED",
        requiredActivation: "B1",
        detail:
          "human recruitment B1 is active, but this external action does not match the exact approved intent id",
        evaluatedAt,
      });
    }

    return blockDecision({
      operation,
      class: cls,
      rule: "A_MODE_EXTERNAL_WRITE",
      reason: "EXTERNAL_WRITE_DISABLED",
      requiredActivation: "B1",
      detail:
        `general external writes are disabled (externalWritesEnabled=${String(
          config.externalWritesEnabled,
        )}); only an exact configured human-recruitment intent may be activated`,
      evaluatedAt,
    });
  }

  switch (cls) {
    case "READ":
      return allowDecision({
        operation,
        class: cls,
        rule: "A_MODE_PUBLIC_READ",
        detail: "public non-mutating read through the safe network boundary",
        evaluatedAt,
      });
    case "LOCAL_WRITE":
      return allowDecision({
        operation,
        class: cls,
        rule: "A_MODE_LOCAL_WRITE",
        detail: "write confined to local state, cache, logs or the git worktree",
        evaluatedAt,
      });
    case "PREPARE_EXTERNAL_ACTION":
      return allowDecision({
        operation,
        class: cls,
        rule: "A_MODE_PREPARE_ONLY",
        detail:
          "builds an immutable intent describing the action; the external action is not performed",
        evaluatedAt,
      });
    case "TESTNET_ACTION":
      return allowDecision({
        operation,
        class: cls,
        rule: "A_MODE_NON_VALUE_TESTNET",
        detail:
          "non-value testnet or fake-facilitator exercise with no signer, no asset movement " +
          "and no external mutation",
        evaluatedAt,
      });
    default: {
      const exhaustive: never = cls;
      return blockDecision({
        operation,
        class: "UNKNOWN",
        rule: "A_MODE_DENY_BY_DEFAULT",
        reason: "POLICY_BLOCKED",
        requiredActivation: null,
        detail: `unhandled class ${String(exhaustive)}`,
        evaluatedAt,
      });
    }
  }
}

/**
 * Evaluates and throws a typed error when blocked.
 *
 * Used at callsites where proceeding past a block would be a bug. Callers that
 * need to *report* a block (the intent engine) use evaluatePolicy directly and
 * embed the decision.
 */
export function assertAllowed(
  config: CommerceConfig,
  request: PolicyRequest,
  now: Date = new Date(),
): PolicyDecision {
  const decision = evaluatePolicy(config, request, now);
  if (decision.decision === "block") {
    throw new CommerceError(decision.reason ?? "POLICY_BLOCKED", decision.detail, {
      operation: decision.operation,
      rule: decision.rule,
      requiredActivation: decision.requiredActivation,
    });
  }
  return decision;
}
