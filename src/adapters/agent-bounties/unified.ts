import { canonicalWorkId } from "../../core/ids.js";
import { atomicToDecimalString } from "../../core/money.js";
import { modeAWorkActionability, type VerifierType, type WorkCandidate } from "../../core/models.js";
import type { AdapterContext } from "../interface.js";

const USDC_DECIMALS = 6;

export const COMPETITION_PAYMENT_PROOF_RULE =
  "Only a confirmed canonical CompetitionSettledV2 event matching the competition and solver proves payment.";
export const BOUNTY_PAYMENT_PROOF_RULE =
  "Only a confirmed canonical BountySettled event matching the bounty and solver proves payment.";

interface AmountRecord {
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly unit?: unknown;
  readonly decimals?: unknown;
}

interface UnifiedOpportunity {
  readonly opportunity_id?: unknown;
  readonly source_type?: unknown;
  readonly source_id?: unknown;
  readonly source_status?: unknown;
  readonly title?: unknown;
  readonly goal?: unknown;
  readonly categories?: unknown;
  readonly skills?: unknown;
  readonly public_url?: unknown;
  readonly work_state?: unknown;
  readonly payment_state?: unknown;
  readonly payment_committed?: unknown;
  readonly competition_mode?: unknown;
  readonly network?: unknown;
  readonly verifier_profile_id?: unknown;
  readonly verifier_profile_name?: unknown;
  readonly standing_meta_bounty?: unknown;
  readonly reward?: unknown;
  readonly cash_economics?: unknown;
  readonly deadline?: unknown;
  readonly verification_method?: unknown;
  readonly verification_ready?: unknown;
  readonly evidence_requirements?: unknown;
  readonly next_action?: unknown;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .slice(0, 32),
  );
}

function atomicUsdc(value: unknown): string | undefined {
  const amount = record(value) as AmountRecord | undefined;
  const raw = string(amount?.amount);
  const currency = string(amount?.currency)?.toUpperCase();
  const unit = string(amount?.unit);
  const decimals = amount?.decimals;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  if (currency !== "USDC" || unit !== "base_units" || decimals !== USDC_DECIMALS) return undefined;
  return raw;
}

function verifierType(item: UnifiedOpportunity): VerifierType {
  if (item.verification_ready !== true) return "unknown";
  const method = string(item.verification_method)?.toLowerCase() ?? "";
  const profile = string(item.verifier_profile_id)?.toLowerCase() ?? "";
  if (
    method.includes("sp1") ||
    method.includes("deterministic") ||
    profile.includes("deterministic") ||
    profile.includes("attribution-metric")
  ) return "deterministic";
  if (method.includes("operator")) return "operator";
  if (method.includes("ai") || method.includes("judge")) return "ai_oracle";
  return "unknown";
}

function participationPhase(item: UnifiedOpportunity): string | undefined {
  return string(record(item.evidence_requirements)?.participation_phase);
}

function canPrepare(item: UnifiedOpportunity): boolean {
  if (string(item.work_state) !== "claimable") return false;
  if (string(item.payment_state) !== "escrowed") return false;
  if (item.payment_committed !== true || item.verification_ready !== true) return false;
  if (string(item.opportunity_id)?.startsWith("open-competition-v2:") === true) {
    return participationPhase(item) === "scoring";
  }
  return true;
}

function requirementsFor(item: UnifiedOpportunity): readonly string[] {
  const out: string[] = [];
  const categories = stringArray(item.categories);
  const skills = stringArray(item.skills);
  if (categories.length > 0) out.push(`categories: ${categories.join(", ")}`);
  if (skills.length > 0) out.push(`skills: ${skills.join(", ")}`);
  const competitionMode = string(item.competition_mode);
  if (competitionMode !== undefined) out.push(`competition mode: ${competitionMode}`);
  if (item.standing_meta_bounty === true) out.push("standing meta bounty");

  const economics = record(item.cash_economics);
  const spend = atomicUsdc(economics?.required_external_spend);
  const margin = atomicUsdc(economics?.gross_cash_margin);
  if (spend !== undefined) {
    out.push(`required external spend: ${atomicToDecimalString(spend, USDC_DECIMALS)} USDC`);
  }
  if (margin !== undefined) {
    out.push(`advertised gross cash margin before unlisted costs: ${atomicToDecimalString(margin, USDC_DECIMALS)} USDC`);
  }

  const evidence = record(item.evidence_requirements);
  const qualifying = record(evidence?.qualifying_action);
  const objective = string(qualifying?.objective);
  if (objective !== undefined) out.push(`qualifying action: ${objective}`);
  const phase = string(evidence?.participation_phase);
  if (phase !== undefined) out.push(`participation phase: ${phase}`);
  const scoringWindow = record(evidence?.scoring_window);
  const startsAt = string(scoringWindow?.starts_at);
  const endsAt = string(scoringWindow?.ends_at);
  if (startsAt !== undefined || endsAt !== undefined) {
    out.push(`scoring window: ${startsAt ?? "unknown"} to ${endsAt ?? "unknown"}`);
  }

  const nextAction = record(item.next_action);
  const instructions = string(nextAction?.instructions);
  if (instructions !== undefined) out.push(`safe next action: ${instructions}`);
  return Object.freeze(out.slice(0, 32));
}

export function normalizeUnifiedOpportunity(
  raw: unknown,
  context: AdapterContext,
  sourceUrl: string,
  defaultNetwork: string,
): WorkCandidate | null {
  const item = record(raw) as UnifiedOpportunity | undefined;
  if (item === undefined) return null;
  const opportunityId = string(item.opportunity_id);
  const sourceId = string(item.source_id);
  const rewardAtomic = atomicUsdc(item.reward);
  if (opportunityId === undefined || sourceId === undefined || rewardAtomic === undefined) return null;

  const rewardDecimal = atomicToDecimalString(rewardAtomic, USDC_DECIMALS);
  const title = string(item.title) ?? opportunityId;
  const goal = string(item.goal);
  const publicUrl = string(item.public_url);
  const network = string(item.network) ?? defaultNetwork;
  const workState = string(item.work_state);
  const paymentState = string(item.payment_state);
  const verification = verifierType(item);
  const deadline = string(item.deadline);
  const isCompetition = opportunityId.startsWith("open-competition-v2:");
  const proofRule = isCompetition ? COMPETITION_PAYMENT_PROOF_RULE : BOUNTY_PAYMENT_PROOF_RULE;

  context.evidence.observe("opportunity_work_state", workState ?? "unknown", "http_api", sourceUrl);
  context.evidence.observe("opportunity_payment_state", paymentState ?? "unknown", "http_api", sourceUrl);
  context.evidence.observe("solver_reward_atomic", rewardAtomic, "http_api", sourceUrl);
  context.evidence.infer("verifier_type", verification, "http_api", sourceUrl);
  context.evidence.infer("payment_proof_rule", proofRule, "docs", sourceUrl);

  const prepare = canPrepare(item);
  return {
    id: canonicalWorkId({ source: "agent_bounties", externalId: opportunityId }),
    kind: "work",
    source: "agent_bounties",
    externalId: opportunityId,
    title,
    ...(goal === undefined ? {} : { description: goal }),
    ...(publicUrl === undefined ? {} : { url: publicUrl }),
    reward: {
      amount: rewardDecimal,
      asset: "USDC",
      network,
      usd: rewardDecimal,
    },
    funding: {
      state: paymentState === "escrowed" ? "funded" : "unknown",
      evidence: "observed",
    },
    verification: {
      type: verification,
      description:
        string(item.verifier_profile_name) ??
        string(item.verification_method) ??
        "verifier readiness not established",
    },
    ...(deadline === undefined ? {} : { deadline }),
    requirements: requirementsFor(item),
    status: workState === "claimable" ? "open" : "unknown",
    paymentProofRule: proofRule,
    observedAt: context.clock(),
    evidence: context.evidence.records(),
    actionability: modeAWorkActionability({ canPrepareClaim: prepare }),
  };
}

export function unifiedReadyToEarnUrl(baseUrl: string, network: string, limit = 300): string {
  const url = new URL("/v1/opportunities", baseUrl);
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit), 1), 300)));
  url.searchParams.set("network", network);
  url.searchParams.set("source_type", "canonical_base");
  url.searchParams.set("view", "ready_to_earn");
  return url.toString();
}
