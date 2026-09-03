/**
 * Operation classes and activation stages.
 *
 * Every operation the control plane performs is classified into exactly one of
 * these. Classification is what the policy engine decides on; there is no
 * per-callsite discretion.
 */

export const OPERATION_CLASSES = [
  /** Public, non-mutating read of an external source. */
  "READ",
  /** Write confined to local SQLite / local filesystem / the git worktree. */
  "LOCAL_WRITE",
  /** Build an immutable intent describing an action without performing it. */
  "PREPARE_EXTERNAL_ACTION",
  /** Non-value testnet or fake-facilitator exercise. */
  "TESTNET_ACTION",
  /** Any external mutation: registration, publication, claim, submission. */
  "EXTERNAL_WRITE",
  /** Any movement of an asset, on any network, of any size. */
  "VALUE_MOVEMENT",
  /** Reading or deriving a key, seed, token or other spending credential. */
  "SECRET_ACCESS",
] as const;

export type OperationClass = (typeof OPERATION_CLASSES)[number];

/**
 * Future activation stages. Neither is implemented.
 *
 * B1 would permit external non-financial writes; B2 would permit signing and
 * value movement. They are separate designs and separate authorization events,
 * and a successful Mode-A run does not imply either.
 */
export type ActivationStage = "B1" | "B2";

export const MODE_A = "A" as const;
export type Mode = typeof MODE_A;
