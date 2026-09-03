/**
 * Immutable preparation-only action intents.
 *
 * An intent is where a risky operation STOPS. It records everything the system
 * would need in order to act, together with the policy decision that refused to
 * let it act. That is the whole point: it demonstrates the control plane knows
 * how it would pay, claim or publish, without making the external mutation.
 *
 * Structural guarantees:
 *
 *  - This module exports only `create*Intent` functions. There is deliberately
 *    no executor, no `submit`, no `settle`, and no `send`. A caller cannot
 *    "run" an intent because no such function exists anywhere in the package.
 *  - `financialActionExecuted` and `externalMutationExecuted` are literal
 *    `false` types, so a future edit that tries to set one true fails to compile
 *    rather than silently shipping.
 *  - The policy decision is obtained from the central engine, never constructed
 *    locally, so an intent cannot claim to be allowed.
 *  - The intent hash covers the normalized non-secret action inputs, so two
 *    identical preparations hash identically and a reviewer can diff them.
 */
import type { CommerceConfig } from "../config.js";
import { intentId } from "../core/ids.js";
import { hashCanonical } from "../evidence/hashing.js";
import { sanitize } from "../evidence/sanitize.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyDecision } from "../policy/decisions.js";

export type IntentKind = "payment" | "claim" | "publish";

/** Fields every intent carries, regardless of kind. */
export interface IntentBase {
  readonly id: string;
  readonly kind: IntentKind;
  readonly platform: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly hash: string;
  readonly mode: "A";
  readonly decision: PolicyDecision;
  /** Always false in Mode A. Literal-typed so it cannot drift. */
  readonly financialActionExecuted: false;
  readonly externalMutationExecuted: false;
}

export interface PaymentIntent extends IntentBase {
  readonly kind: "payment";
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network: string | null;
  readonly asset: Readonly<Record<string, unknown>> | null;
  readonly price: Readonly<Record<string, unknown>> | null;
  readonly payTo: string | null;
  readonly requirements: Readonly<Record<string, unknown>>;
  /** Never true in Mode A: no signer exists. */
  readonly signerPresent: false;
  readonly walletPresent: false;
}

export interface ClaimIntent extends IntentBase {
  readonly kind: "claim";
  readonly title: string;
  readonly reward: Readonly<Record<string, unknown>>;
  readonly funding: Readonly<Record<string, unknown>>;
  readonly verification: Readonly<Record<string, unknown>>;
  readonly requirements: readonly string[];
  readonly externalStepsRequired: readonly string[];
  readonly paymentProofRule: string | null;
  readonly claimBroadcast: false;
  readonly submissionBroadcast: false;
}

export interface PublishIntent extends IntentBase {
  readonly kind: "publish";
  readonly product: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly targetReady: boolean;
  readonly reason: string | null;
  readonly registrationPerformed: false;
  readonly publicationPerformed: false;
}

export type CommerceIntent = PaymentIntent | ClaimIntent | PublishIntent;

export interface IntentClock {
  (): string;
}

const defaultClock: IntentClock = () => new Date().toISOString();

/**
 * Builds the shared, hashable core of an intent.
 *
 * The body is sanitized before hashing so a credential that leaked into an
 * adapter's preparation payload can never be committed to an intent hash.
 */
function baseFor(
  config: CommerceConfig,
  kind: IntentKind,
  platform: string,
  targetId: string,
  body: Record<string, unknown>,
  operation: string,
  operationClass: "VALUE_MOVEMENT" | "EXTERNAL_WRITE",
  clock: IntentClock,
): IntentBase {
  const createdAt = clock();
  const decision = evaluatePolicy(
    config,
    {
      operation,
      class: operationClass,
      platform,
    },
    new Date(createdAt),
  );

  // Hash covers the normalized, sanitized action inputs plus identity, but not
  // the timestamp, so two identical preparations are comparable.
  const hashable = sanitize({ kind, platform, targetId, body });
  const hash = hashCanonical(hashable);

  return Object.freeze({
    id: intentId(kind, hashable),
    kind,
    platform,
    targetId,
    createdAt,
    hash,
    mode: "A" as const,
    decision,
    financialActionExecuted: false as const,
    externalMutationExecuted: false as const,
  });
}

export interface CreatePaymentIntentInput {
  readonly platform: string;
  readonly targetId: string;
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network?: string | null | undefined;
  readonly asset?: Readonly<Record<string, unknown>> | null | undefined;
  readonly price?: Readonly<Record<string, unknown>> | null | undefined;
  readonly payTo?: string | null | undefined;
  readonly requirements?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Prepares a payment without paying.
 *
 * Classified VALUE_MOVEMENT, so Mode-A policy blocks it with
 * LIVE_VALUE_MOVEMENT_DISABLED under rule A_MODE_VALUE_MOVEMENT.
 */
export function createPaymentIntent(
  config: CommerceConfig,
  input: CreatePaymentIntentInput,
  clock: IntentClock = defaultClock,
): PaymentIntent {
  const body: Record<string, unknown> = {
    resourceUrl: input.resourceUrl,
    method: input.method,
    protocol: input.protocol,
    network: input.network ?? null,
    asset: input.asset ?? null,
    price: input.price ?? null,
    payTo: input.payTo ?? null,
    requirements: input.requirements ?? {},
  };
  const base = baseFor(
    config,
    "payment",
    input.platform,
    input.targetId,
    body,
    "commerce_prepare_purchase",
    "VALUE_MOVEMENT",
    clock,
  );
  return Object.freeze({
    ...base,
    kind: "payment" as const,
    resourceUrl: input.resourceUrl,
    method: input.method,
    protocol: input.protocol,
    network: input.network ?? null,
    asset: input.asset ?? null,
    price: input.price ?? null,
    payTo: input.payTo ?? null,
    requirements: Object.freeze({ ...(input.requirements ?? {}) }),
    signerPresent: false as const,
    walletPresent: false as const,
  });
}

export interface CreateClaimIntentInput {
  readonly platform: string;
  readonly targetId: string;
  readonly title: string;
  readonly reward: Readonly<Record<string, unknown>>;
  readonly funding: Readonly<Record<string, unknown>>;
  readonly verification: Readonly<Record<string, unknown>>;
  readonly requirements?: readonly string[] | undefined;
  readonly externalStepsRequired?: readonly string[] | undefined;
  readonly paymentProofRule?: string | null | undefined;
}

/**
 * Prepares a bounty claim without claiming.
 *
 * Classified EXTERNAL_WRITE, so Mode-A policy blocks it with
 * EXTERNAL_WRITE_DISABLED under rule A_MODE_EXTERNAL_WRITE.
 */
export function createClaimIntent(
  config: CommerceConfig,
  input: CreateClaimIntentInput,
  clock: IntentClock = defaultClock,
): ClaimIntent {
  const body: Record<string, unknown> = {
    title: input.title,
    reward: input.reward,
    funding: input.funding,
    verification: input.verification,
    requirements: input.requirements ?? [],
    externalStepsRequired: input.externalStepsRequired ?? [],
    paymentProofRule: input.paymentProofRule ?? null,
  };
  const base = baseFor(
    config,
    "claim",
    input.platform,
    input.targetId,
    body,
    "commerce_prepare_claim",
    "EXTERNAL_WRITE",
    clock,
  );
  return Object.freeze({
    ...base,
    kind: "claim" as const,
    title: input.title,
    reward: Object.freeze({ ...input.reward }),
    funding: Object.freeze({ ...input.funding }),
    verification: Object.freeze({ ...input.verification }),
    requirements: Object.freeze([...(input.requirements ?? [])]),
    externalStepsRequired: Object.freeze([...(input.externalStepsRequired ?? [])]),
    paymentProofRule: input.paymentProofRule ?? null,
    claimBroadcast: false as const,
    submissionBroadcast: false as const,
  });
}

export interface CreatePublishIntentInput {
  readonly platform: string;
  readonly targetId: string;
  readonly product: string;
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly targetReady?: boolean | undefined;
  readonly reason?: string | null | undefined;
}

/**
 * Prepares a publication without publishing.
 *
 * Classified EXTERNAL_WRITE, so Mode-A policy blocks it with
 * EXTERNAL_WRITE_DISABLED under rule A_MODE_EXTERNAL_WRITE.
 */
export function createPublishIntent(
  config: CommerceConfig,
  input: CreatePublishIntentInput,
  clock: IntentClock = defaultClock,
): PublishIntent {
  const manifestHash = hashCanonical(sanitize(input.manifest));
  const body: Record<string, unknown> = {
    product: input.product,
    version: input.version,
    manifestHash,
    targetReady: input.targetReady ?? false,
    reason: input.reason ?? null,
  };
  const base = baseFor(
    config,
    "publish",
    input.platform,
    input.targetId,
    body,
    "commerce_prepare_publish",
    "EXTERNAL_WRITE",
    clock,
  );
  return Object.freeze({
    ...base,
    kind: "publish" as const,
    product: input.product,
    version: input.version,
    manifestHash,
    manifest: Object.freeze({ ...input.manifest }),
    targetReady: input.targetReady ?? false,
    reason: input.reason ?? null,
    registrationPerformed: false as const,
    publicationPerformed: false as const,
  });
}

/** Projects an intent into the record shape the repository persists. */
export function intentToRecord(intent: CommerceIntent): {
  id: string;
  kind: string;
  platform: string;
  targetId: string;
  createdAt: string;
  hash: string;
  body: unknown;
  decisionRule: string;
  decisionOutcome: string;
  financialActionExecuted: boolean;
  externalMutationExecuted: boolean;
} {
  return {
    id: intent.id,
    kind: intent.kind,
    platform: intent.platform,
    targetId: intent.targetId,
    createdAt: intent.createdAt,
    hash: intent.hash,
    body: sanitize(intent),
    decisionRule: intent.decision.rule,
    decisionOutcome: intent.decision.decision,
    financialActionExecuted: intent.financialActionExecuted,
    externalMutationExecuted: intent.externalMutationExecuted,
  };
}
