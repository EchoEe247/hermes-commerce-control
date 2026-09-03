/** Read-only source adapter contract for opportunity discovery. */
import type { SafeFetch } from "../../network/safe-fetch.js";
import type {
  OpportunityCandidate,
  OpportunityQuery,
  OpportunitySourceId,
} from "../models.js";

export interface OpportunityAdapterContext {
  /** Shared SSRF-safe, credentialless HTTP boundary. */
  readonly fetch: Pick<SafeFetch, "text">;
  readonly clock: () => string;
  readonly signal: AbortSignal;
}

export interface OpportunitySourceAdapter {
  readonly id: OpportunitySourceId;
  discover(
    query: OpportunityQuery,
    context: OpportunityAdapterContext,
  ): Promise<readonly OpportunityCandidate[]>;
}
