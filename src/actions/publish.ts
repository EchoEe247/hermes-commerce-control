/**
 * Publication preparation.
 *
 * Converts a product manifest plus a target's readiness assessment into a
 * canonical PublishIntent. No publishing or registering function is provided:
 * creating a production listing is an external write.
 *
 * The prose here avoids literal execute-style identifiers, because the security
 * test greps these files for them and that grep must stay strict.
 */
import type { CommerceConfig } from "../config.js";
import { createPublishIntent, type PublishIntent } from "./intents.js";

export interface PublishFacts {
  readonly platform: string;
  readonly product: string;
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly targetReady?: boolean | undefined;
  readonly reason?: string | null | undefined;
}

/** Builds a blocked PublishIntent from a manifest and readiness assessment. */
export function preparePublish(
  config: CommerceConfig,
  targetId: string,
  facts: PublishFacts,
  clock?: () => string,
): PublishIntent {
  return createPublishIntent(
    config,
    {
      platform: facts.platform,
      targetId,
      product: facts.product,
      version: facts.version,
      manifest: facts.manifest,
      targetReady: facts.targetReady ?? false,
      reason: facts.reason ?? null,
    },
    clock,
  );
}
