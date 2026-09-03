/**
 * Zero-cost deterministic pre-triage.
 *
 * This layer exists to avoid spending model tokens or limited enrichment calls
 * on obviously unsuitable listings. It never claims to know whether a listing
 * is legitimate or profitable; ambiguous cases remain `review` and can be sent
 * to a later model/human evaluator.
 */
import type { OpportunityCandidate } from "./models.js";

export const OPPORTUNITY_TRIAGE_DECISIONS = ["candidate", "review", "reject"] as const;
export type OpportunityTriageDecision = (typeof OPPORTUNITY_TRIAGE_DECISIONS)[number];

export type BudgetBasis = "fixed" | "hourly" | "unknown";

export interface BudgetSignal {
  readonly minUsd: number;
  readonly maxUsd?: number | undefined;
  readonly basis: BudgetBasis;
  readonly matchedText: string;
}

export interface OpportunityTriageProfile {
  /** Positive-fit vocabulary. Each distinct match adds score, capped. */
  readonly preferredTerms?: readonly string[] | undefined;
  /** Hard exclusion vocabulary controlled by the caller. */
  readonly excludedTerms?: readonly string[] | undefined;
  /** Reject an explicitly local/in-person listing. Unknown location stays reviewable. */
  readonly requireRemote?: boolean | undefined;
  /** Reject an explicit seller/service-offer post; ambiguous intent stays reviewable. */
  readonly requireDemand?: boolean | undefined;
  /** Only applied to a clearly fixed-price USD amount, never hourly/unknown amounts. */
  readonly minimumKnownFixedUsd?: number | undefined;
}

export interface OpportunityTriageSignals {
  readonly demandIntent: boolean;
  readonly supplyIntent: boolean;
  readonly paidIntent: boolean;
  readonly unpaidIntent: boolean;
  readonly remote: boolean;
  readonly localOrInPerson: boolean;
  readonly preferredTermMatches: readonly string[];
  readonly excludedTermMatches: readonly string[];
  readonly budget?: BudgetSignal | undefined;
}

export interface OpportunityTriageResult {
  readonly opportunityId: string;
  readonly decision: OpportunityTriageDecision;
  readonly score: number;
  readonly reasons: readonly string[];
  /** Caution signals are not fraud determinations. */
  readonly cautionFlags: readonly string[];
  readonly signals: OpportunityTriageSignals;
}

const PAID_TERMS = [
  "hiring",
  "paid",
  "budget",
  "bounty",
  "compensation",
  "paying",
  "payment",
] as const;

const UNPAID_TERMS = [
  "unpaid",
  "volunteer",
  "no compensation",
  "for exposure",
  "equity only",
] as const;

const REMOTE_TERMS = [
  "remote",
  "online",
  "work from home",
  "work-from-home",
  "anywhere",
  "virtual",
] as const;

const LOCAL_TERMS = [
  "in person",
  "in-person",
  "onsite",
  "on-site",
  "local only",
  "must be local",
  "pickup",
  "pick up",
  "physical location",
] as const;

const DEMAND_PATTERNS = [
  /^\s*\[(?:hiring|task|request|wanted|job)\]/i,
  /\blooking\s+to\s+hire\b/i,
  /\blooking\s+for\s+(?:someone|a\s+developer|a\s+freelancer|a\s+contractor|help)\b/i,
  /\bneed\s+(?:someone|a\s+developer|a\s+freelancer|a\s+contractor|help)\b/i,
  /\bseeking\s+(?:someone|a\s+developer|a\s+freelancer|a\s+contractor|help)\b/i,
] as const;

const SUPPLY_PATTERNS = [
  /^\s*\[(?:for\s*hire|offer|offering|hire\s*me)\]/i,
  /\bavailable\s+for\s+(?:work|projects?|hire)\b/i,
  /\bhire\s+me\b/i,
  /\bmy\s+(?:freelance\s+)?services\b/i,
] as const;

const CAUTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:pay|send|deposit)\b.{0,32}\b(?:fee|deposit|money)\b/i, "upfront-payment-language"],
  [/\bgift\s*card\b/i, "gift-card-language"],
  [/\btelegram\s+only\b/i, "telegram-only-contact"],
  [/\b(?:guaranteed|easy)\s+(?:money|income|profit)\b/i, "guaranteed-income-language"],
];

function normalizedText(candidate: OpportunityCandidate): string {
  return `${candidate.title}\n${candidate.body ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedTerm(term: string): string {
  return term.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizedTerm(phrase);
  if (needle === "") return false;
  const pattern = escapeRegex(needle).replace(/\\ /g, "\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(haystack);
}

function matchingTerms(haystack: string, terms: readonly string[] | undefined): string[] {
  if (terms === undefined) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const raw of terms) {
    const term = normalizedTerm(raw);
    if (term === "" || seen.has(term) || !containsPhrase(haystack, term)) continue;
    seen.add(term);
    matches.push(term);
  }
  return matches;
}

function asAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > 100_000_000) return undefined;
  return Math.round(value * 100) / 100;
}

function budgetBasis(raw: string | undefined): BudgetBasis {
  if (raw === undefined || raw.trim() === "") return "fixed";
  return /hour|hr/i.test(raw) ? "hourly" : "fixed";
}

/**
 * Extracts an explicitly USD-denominated amount. Bare numbers are ignored so a
 * year, quantity, karma score, or model number cannot accidentally become a
 * budget. The first usable explicit amount wins.
 */
export function extractUsdBudget(text: string): BudgetSignal | undefined {
  const patterns = [
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(?:-|–|—|to)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?))?\s*(?:usd\b)?\s*((?:\/|per\s+)?(?:hour|hr|project|task|job))?/i,
    /\busd\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(?:-|–|—|to)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?))?\s*((?:\/|per\s+)?(?:hour|hr|project|task|job))?/i,
    /\b(\d[\d,]*(?:\.\d{1,2})?)\s*usd\b\s*((?:\/|per\s+)?(?:hour|hr|project|task|job))?/i,
  ] as const;

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const min = asAmount(match[1]);
    if (min === undefined) continue;
    const max = asAmount(match[2]);
    const suffix = max === undefined ? (match[3] ?? match[2]) : match[3];
    const low = max === undefined ? min : Math.min(min, max);
    const high = max === undefined ? undefined : Math.max(min, max);
    return Object.freeze({
      minUsd: low,
      ...(high === undefined ? {} : { maxUsd: high }),
      basis: budgetBasis(suffix),
      matchedText: match[0].trim(),
    });
  }
  return undefined;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function triageOpportunity(
  candidate: OpportunityCandidate,
  profile: OpportunityTriageProfile = {},
): OpportunityTriageResult {
  const text = normalizedText(candidate);
  const demandIntent = DEMAND_PATTERNS.some((pattern) => pattern.test(text));
  const supplyIntent = SUPPLY_PATTERNS.some((pattern) => pattern.test(text));
  const paidIntent = PAID_TERMS.some((term) => containsPhrase(text, term));
  const unpaidIntent = UNPAID_TERMS.some((term) => containsPhrase(text, term));
  const remote = REMOTE_TERMS.some((term) => containsPhrase(text, term));
  const localOrInPerson = LOCAL_TERMS.some((term) => containsPhrase(text, term));
  const preferredTermMatches = matchingTerms(text, profile.preferredTerms);
  const excludedTermMatches = matchingTerms(text, profile.excludedTerms);
  const budget = extractUsdBudget(text);

  const reasons: string[] = [];
  const cautionFlags: string[] = [];
  let score = 45;
  let hardReject = false;

  if (demandIntent) {
    score += 12;
    reasons.push("explicit buyer/demand intent");
  }
  if (supplyIntent) {
    score -= 20;
    reasons.push("explicit seller/service-offer intent");
  }
  if (paidIntent) {
    score += 10;
    reasons.push("explicit paid/hiring language");
  }
  if (budget !== undefined) {
    score += 10;
    reasons.push(`explicit USD budget (${budget.matchedText})`);
  }
  if (remote) {
    score += 8;
    reasons.push("explicit remote/online language");
  }
  if (preferredTermMatches.length > 0) {
    score += Math.min(24, preferredTermMatches.length * 8);
    reasons.push(`preferred term match: ${preferredTermMatches.join(", ")}`);
  }

  if (profile.requireDemand === true && supplyIntent && !demandIntent) {
    score -= 40;
    hardReject = true;
    reasons.push("explicit seller/service-offer post conflicts with demand-only profile");
  }
  if (unpaidIntent) {
    score -= 60;
    hardReject = true;
    reasons.push("explicit unpaid/volunteer language");
  }
  if (profile.requireRemote === true && localOrInPerson && !remote) {
    score -= 50;
    hardReject = true;
    reasons.push("explicit local/in-person requirement conflicts with remote-only profile");
  } else if (localOrInPerson && !remote) {
    score -= 15;
    reasons.push("explicit local/in-person language");
  }
  if (excludedTermMatches.length > 0) {
    score -= 50;
    hardReject = true;
    reasons.push(`excluded term match: ${excludedTermMatches.join(", ")}`);
  }

  if (
    profile.minimumKnownFixedUsd !== undefined &&
    budget !== undefined &&
    budget.basis === "fixed" &&
    budget.maxUsd !== undefined &&
    budget.maxUsd < profile.minimumKnownFixedUsd
  ) {
    score -= 50;
    hardReject = true;
    reasons.push(
      `known fixed-price maximum $${String(budget.maxUsd)} is below minimum $${String(profile.minimumKnownFixedUsd)}`,
    );
  } else if (
    profile.minimumKnownFixedUsd !== undefined &&
    budget !== undefined &&
    budget.basis === "fixed" &&
    budget.maxUsd === undefined &&
    budget.minUsd < profile.minimumKnownFixedUsd
  ) {
    score -= 35;
    hardReject = true;
    reasons.push(
      `known fixed price $${String(budget.minUsd)} is below minimum $${String(profile.minimumKnownFixedUsd)}`,
    );
  }

  for (const [pattern, flag] of CAUTION_PATTERNS) {
    if (pattern.test(text)) cautionFlags.push(flag);
  }
  if (cautionFlags.length > 0) {
    score -= Math.min(20, cautionFlags.length * 5);
    reasons.push(`caution signal(s): ${cautionFlags.join(", ")}`);
  }

  const finalScore = clampScore(score);
  const decision: OpportunityTriageDecision = hardReject
    ? "reject"
    : finalScore >= 65
      ? "candidate"
      : "review";

  const signals: OpportunityTriageSignals = Object.freeze({
    demandIntent,
    supplyIntent,
    paidIntent,
    unpaidIntent,
    remote,
    localOrInPerson,
    preferredTermMatches: Object.freeze(preferredTermMatches),
    excludedTermMatches: Object.freeze(excludedTermMatches),
    ...(budget === undefined ? {} : { budget }),
  });

  return Object.freeze({
    opportunityId: candidate.id,
    decision,
    score: finalScore,
    reasons: Object.freeze(reasons),
    cautionFlags: Object.freeze(cautionFlags),
    signals,
  });
}

export function triageOpportunities(
  candidates: readonly OpportunityCandidate[],
  profile: OpportunityTriageProfile = {},
): readonly OpportunityTriageResult[] {
  return Object.freeze(candidates.map((candidate) => triageOpportunity(candidate, profile)));
}
