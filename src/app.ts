/**
 * Hermes Commerce Control Plane — application metadata.
 *
 * Mode A is compiled in as a frozen constant. There is deliberately no code
 * path in this package that can produce a mode other than "A": activation of
 * external writes (Stage B1) or live value movement (Stage B2) requires a
 * separate design, a separate authorization event, and a code change.
 */

export const APP_NAME = "hermes-commerce-control" as const;
export const APP_VERSION = "0.1.0" as const;
export const APP_MODE = "A" as const;

export interface AppMetadata {
  readonly name: typeof APP_NAME;
  readonly version: typeof APP_VERSION;
  readonly mode: typeof APP_MODE;
}

/** Returns the frozen Mode-A identity of this control plane. */
export function buildAppMetadata(): AppMetadata {
  return Object.freeze({
    name: APP_NAME,
    version: APP_VERSION,
    mode: APP_MODE,
  });
}
