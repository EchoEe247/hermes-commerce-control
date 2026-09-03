/**
 * Claim preparation.
 *
 * Converts an adapter's claim draft into a canonical ClaimIntent. No claiming or
 * work-submitting function is provided: both are external writes, and Stage B1 is
 * not implemented.
 *
 * The prose here avoids literal execute-style identifiers, because the security
 * test greps these files for them and that grep must stay strict.
 */
import type { CommerceConfig } from "../config.js";
import { createClaimIntent, type ClaimIntent } from "./intents.js";

export interface ClaimFacts {
  readonly platform: string;
  readonly title: string;
  readonly reward: Readonly<Record<string, unknown>>;
  readonly funding: Readonly<Record<string, unknown>>;
  readonly verification: Readonly<Record<string, unknown>>;
  readonly requirements?: readonly string[] | undefined;
  readonly externalStepsRequired?: readonly string[] | undefined;
  readonly paymentProofRule?: string | null | undefined;
}

/** Builds a blocked ClaimIntent from adapter-supplied facts. */
export function prepareClaim(
  config: CommerceConfig,
  targetId: string,
  facts: ClaimFacts,
  clock?: () => string,
): ClaimIntent {
  return createClaimIntent(
    config,
    {
      platform: facts.platform,
      targetId,
      title: facts.title,
      reward: facts.reward,
      funding: facts.funding,
      verification: facts.verification,
      requirements: facts.requirements ?? [],
      externalStepsRequired: facts.externalStepsRequired ?? [],
      paymentProofRule: facts.paymentProofRule ?? null,
    },
    clock,
  );
}
