/**
 * Adapter capability declarations.
 *
 * An adapter must declare what it supports. The registry refuses to call an
 * operation an adapter has not declared, so "the SDK happens to expose a pay
 * method" can never become "the control plane called pay".
 */

export interface AdapterCapabilities {
  readonly discoverServices: boolean;
  readonly discoverWork: boolean;
  readonly inspect: boolean;
  readonly quote: boolean;
  /** Preparation-only: builds an intent, never performs the action. */
  readonly preparePurchase: boolean;
  readonly prepareClaim: boolean;
  readonly preparePublish: boolean;
  /** True when the adapter needs no credentials at all. */
  readonly walletless: boolean;
  /**
   * Always false in Mode A. Present so the capability surface can express the
   * distinction explicitly rather than by omission.
   */
  readonly liveExecution: false;
  readonly notes?: readonly string[] | undefined;
}

const NONE: AdapterCapabilities = Object.freeze({
  discoverServices: false,
  discoverWork: false,
  inspect: false,
  quote: false,
  preparePurchase: false,
  prepareClaim: false,
  preparePublish: false,
  walletless: true,
  liveExecution: false as const,
});

/** Builds a capability set, defaulting everything unstated to unsupported. */
export function capabilities(
  overrides: Partial<Omit<AdapterCapabilities, "liveExecution">> = {},
): AdapterCapabilities {
  return Object.freeze({ ...NONE, ...overrides, liveExecution: false as const });
}
