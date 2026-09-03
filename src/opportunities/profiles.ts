import { CommerceError } from "../core/errors.js";
import type { OpportunityTriageProfile } from "./triage.js";

export const OPPORTUNITY_PROFILE_IDS = [
  "all",
  "demand",
  "remote-demand",
  "automation-demand",
  "automation-remote",
] as const;
export type OpportunityProfileId = (typeof OPPORTUNITY_PROFILE_IDS)[number];

const AUTOMATION_TERMS = Object.freeze([
  "automation",
  "workflow",
  "api",
  "integration",
  "webhook",
  "crm",
  "spreadsheet",
  "data cleanup",
  "scraping",
  "n8n",
  "zapier",
  "make.com",
  "ai agent",
] as const);

const PROFILES: Readonly<Record<OpportunityProfileId, OpportunityTriageProfile>> = Object.freeze({
  all: Object.freeze({}),
  demand: Object.freeze({ requireDemand: true }),
  "remote-demand": Object.freeze({ requireDemand: true, requireRemote: true }),
  "automation-demand": Object.freeze({
    requireDemand: true,
    preferredTerms: AUTOMATION_TERMS,
  }),
  "automation-remote": Object.freeze({
    requireDemand: true,
    requireRemote: true,
    preferredTerms: AUTOMATION_TERMS,
  }),
});

export interface ResolvedOpportunityProfile {
  readonly id: OpportunityProfileId;
  readonly triage: OpportunityTriageProfile;
}

export function resolveOpportunityProfile(raw: string | undefined): ResolvedOpportunityProfile {
  const normalized = (raw ?? "demand").trim().toLowerCase();
  if (!(OPPORTUNITY_PROFILE_IDS as readonly string[]).includes(normalized)) {
    throw new CommerceError(
      "INVALID_INPUT",
      `unknown opportunity profile ${JSON.stringify(raw)}; expected one of ${OPPORTUNITY_PROFILE_IDS.join(", ")}`,
    );
  }
  const id = normalized as OpportunityProfileId;
  return Object.freeze({ id, triage: PROFILES[id] });
}

function mergeTerms(
  base: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): readonly string[] | undefined {
  if (extra === undefined || extra.length === 0) return base;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(base ?? []), ...extra]) {
    const term = raw.trim();
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return Object.freeze(out);
}

/**
 * Applies explicit CLI/environment overrides to a named profile. Positive and
 * exclusion terms are additive; booleans only move toward stricter filtering.
 */
export function extendOpportunityProfile(
  base: OpportunityTriageProfile,
  extra: OpportunityTriageProfile,
): OpportunityTriageProfile {
  const preferredTerms = mergeTerms(base.preferredTerms, extra.preferredTerms);
  const excludedTerms = mergeTerms(base.excludedTerms, extra.excludedTerms);
  return Object.freeze({
    ...(preferredTerms === undefined ? {} : { preferredTerms }),
    ...(excludedTerms === undefined ? {} : { excludedTerms }),
    ...(base.requireDemand === true || extra.requireDemand === true ? { requireDemand: true } : {}),
    ...(base.requireRemote === true || extra.requireRemote === true ? { requireRemote: true } : {}),
    ...(extra.minimumKnownFixedUsd !== undefined
      ? { minimumKnownFixedUsd: extra.minimumKnownFixedUsd }
      : base.minimumKnownFixedUsd === undefined
        ? {}
        : { minimumKnownFixedUsd: base.minimumKnownFixedUsd }),
  });
}
