/**
 * Purchase preparation.
 *
 * Bridges an adapter's platform-specific preparation facts into a canonical
 * PaymentIntent. This file exists so the intent engine stays free of
 * platform-shaped knowledge, and so there is exactly one place where a purchase
 * could ever be assembled.
 *
 * No execution function is provided at all. Settling an x402 payment needs a
 * signer, which this control plane does not have and cannot obtain.
 *
 * The prose here avoids literal execute-style identifiers, because the security
 * test greps these files for them and that grep must stay strict.
 */
import type { CommerceConfig } from "../config.js";
import { createPaymentIntent, type PaymentIntent } from "./intents.js";

export interface PurchaseFacts {
  readonly platform: string;
  readonly resourceUrl: string;
  readonly method: string;
  readonly protocol: string;
  readonly network?: string | null | undefined;
  readonly asset?: Readonly<Record<string, unknown>> | null | undefined;
  readonly price?: Readonly<Record<string, unknown>> | null | undefined;
  readonly payTo?: string | null | undefined;
  readonly settlementNote?: string | undefined;
  readonly walletRequired?: boolean | undefined;
  readonly blockedReason?: string | undefined;
}

/** Builds a blocked PaymentIntent from adapter-supplied facts. */
export function preparePurchase(
  config: CommerceConfig,
  targetId: string,
  facts: PurchaseFacts,
  clock?: () => string,
): PaymentIntent {
  const requirements: Record<string, unknown> = {
    ...(facts.settlementNote === undefined ? {} : { settlementNote: facts.settlementNote }),
    ...(facts.walletRequired === undefined ? {} : { walletRequired: facts.walletRequired }),
    ...(facts.blockedReason === undefined ? {} : { adapterBlockedReason: facts.blockedReason }),
  };
  return createPaymentIntent(
    config,
    {
      platform: facts.platform,
      targetId,
      resourceUrl: facts.resourceUrl,
      method: facts.method,
      protocol: facts.protocol,
      network: facts.network ?? null,
      asset: facts.asset ?? null,
      price: facts.price ?? null,
      payTo: facts.payTo ?? null,
      requirements,
    },
    clock,
  );
}
