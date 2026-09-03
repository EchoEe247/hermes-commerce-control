/**
 * Agent Bounties earning adapter.
 *
 * Discovery now uses the platform's unified canonical ready-to-earn projection,
 * confirmed live on 2026-08-30:
 *   GET /v1/opportunities?limit&network&source_type=canonical_base&view=ready_to_earn
 *
 * That projection includes autonomous bounties and Open Competition V2 inventory,
 * so Commerce Control can see the current funded market instead of only the older
 * autonomous-bounty inventory snapshot. Legacy inventory normalization remains
 * exported for historical fixtures and compatibility.
 *
 * No claim, submission, proof, funding, or settlement endpoint is called.
 */
import { capabilities, type AdapterCapabilities } from "../../core/capabilities.js";
import { CommerceError } from "../../core/errors.js";
import { canonicalWorkId } from "../../core/ids.js";
import { atomicToDecimalString } from "../../core/money.js";
import {
  modeAWorkActionability,
  type FundingState,
  type ProbeResult,
  type VerifierType,
  type WorkCandidate,
  type WorkStatus,
} from "../../core/models.js";
import type { AdapterContext, CommerceAdapter, WorkQuery } from "../interface.js";
import { normalizeUnifiedOpportunity, unifiedReadyToEarnUrl } from "./unified.js";

const USDC_DECIMALS = 6;

export const PAYMENT_PROOF_RULE =
  "Only a canonical BountySettled event matching the bounty, recipient, amount, artifact and " +
  "evidence commitments proves payment. Status strings, paid flags and leaderboard rank do not.";

export function mapStatus(raw: unknown): WorkStatus {
  switch (String(raw ?? "").trim().toLowerCase()) {
    case "open":
    case "claimable":
      return "open";
    case "claimed":
      return "claimed";
    case "submitted":
    case "in_review":
    case "verifying":
      return "in_review";
    case "settled":
    case "paid":
    case "refunded":
    case "cancelled":
    case "expired":
      return "closed";
    default:
      return "unknown";
  }
}

export function mapFundingState(raw: unknown, fundedAtomic: string | undefined): FundingState {
  const status = String(raw ?? "").trim().toLowerCase();
  const funded = fundedAtomic !== undefined && /^\d+$/.test(fundedAtomic) && BigInt(fundedAtomic) > 0n;
  switch (status) {
    case "open":
    case "claimable":
      return funded ? "funded" : "advertised";
    case "claimed":
      return "claimed";
    case "submitted":
    case "in_review":
    case "verifying":
      return "submitted";
    case "settled":
    case "paid":
      return "settled";
    case "refunded":
      return "refunded";
    default:
      return funded ? "funded" : "unknown";
  }
}

export function mapVerifier(verificationReady: unknown): {
  type: VerifierType;
  description: string;
} {
  if (verificationReady === true) {
    return {
      type: "deterministic",
      description:
        "verification_ready=true: the bounty commits an executable verifier policy that a solver " +
        "runs and whose exact settlement call is relayed",
    };
  }
  return {
    type: "unknown",
    description: "verification_ready is not true; the verifier policy is not established",
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function atomic(value: unknown): string | undefined {
  const s = str(value);
  return s !== undefined && /^\d+$/.test(s) ? s : undefined;
}

interface InventoryItem {
  readonly bounty_id?: unknown;
  readonly bounty_contract?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly funded_usdc_base_units?: unknown;
  readonly solver_reward_usdc_base_units?: unknown;
  readonly verifier_reward_usdc_base_units?: unknown;
  readonly verification_ready?: unknown;
  readonly standing_meta_bounty?: unknown;
}

export function normalizeBounty(
  item: InventoryItem,
  context: AdapterContext,
  sourceUrl: string,
  network: string,
): WorkCandidate | null {
  const bountyId = str(item.bounty_id);
  if (bountyId === undefined) return null;
  const solverAtomic = atomic(item.solver_reward_usdc_base_units);
  const fundedAtomic = atomic(item.funded_usdc_base_units);
  if (solverAtomic === undefined) {
    context.evidence.tentative(
      "reward",
      `bounty ${bountyId} did not advertise a usable solver reward`,
      "http_api",
      sourceUrl,
    );
    return null;
  }

  const rewardDecimal = atomicToDecimalString(solverAtomic, USDC_DECIMALS);
  const status = mapStatus(item.status);
  const fundingState = mapFundingState(item.status, fundedAtomic);
  const verifier = mapVerifier(item.verification_ready);
  const observedAt = context.clock();
  const title = str(item.title) ?? `bounty ${bountyId}`;
  const contract = str(item.bounty_contract);

  context.evidence.observe("bounty_status", String(item.status ?? "unknown"), "http_api", sourceUrl);
  context.evidence.observe("solver_reward_atomic", solverAtomic, "http_api", sourceUrl);
  if (fundedAtomic !== undefined) context.evidence.observe("funded_atomic", fundedAtomic, "http_api", sourceUrl);
  context.evidence.infer("verifier_type", verifier.type, "http_api", sourceUrl);
  context.evidence.infer("payment_proof_rule", PAYMENT_PROOF_RULE, "docs", `${sourceUrl}#llms.txt`);

  return {
    id: canonicalWorkId({ source: "agent_bounties", externalId: bountyId }),
    kind: "work",
    source: "agent_bounties",
    externalId: bountyId,
    title,
    description: verifier.description,
    ...(contract === undefined ? {} : { url: `https://api.agentbounties.app/v1/bounties/${bountyId}` }),
    reward: { amount: rewardDecimal, asset: "USDC", network, usd: rewardDecimal },
    funding: { state: fundingState, evidence: "observed" },
    verification: { type: verifier.type, description: verifier.description },
    requirements: [
      verifier.description,
      ...(item.standing_meta_bounty === true ? ["standing meta bounty"] : []),
      ...(contract === undefined ? [] : [`bounty contract ${contract}`]),
    ],
    status,
    paymentProofRule: PAYMENT_PROOF_RULE,
    observedAt,
    evidence: context.evidence.records(),
    actionability: modeAWorkActionability({ canPrepareClaim: status === "open" && fundingState === "funded" }),
  };
}

function isLegacyInventory(body: Readonly<Record<string, unknown>>): boolean {
  return String(body.schema_version ?? "").includes("inventory-summary");
}

export class AgentBountiesAdapter implements CommerceAdapter {
  public readonly id = "agent_bounties" as const;

  public constructor(
    private readonly baseUrl: string,
    private readonly network = "base-mainnet",
  ) {}

  public capabilities(): AdapterCapabilities {
    return capabilities({
      discoverWork: true,
      inspect: true,
      prepareClaim: true,
      walletless: true,
      notes: [
        "unified canonical ready-to-earn projection includes autonomous bounties and Open Competition V2",
        "funding/payment claims remain evidence-conservative; canonical settlement event is authoritative",
        "never calls claim, submission, proof, funding or settlement endpoints",
      ],
    });
  }

  public async health(context?: AdapterContext): Promise<ProbeResult> {
    const checkedAt = context?.clock() ?? new Date().toISOString();
    if (context === undefined) return { platform: this.id, status: "degraded", checkedAt, detail: "no context" };
    const started = Date.now();
    try {
      const body = await context.fetch.json<Record<string, unknown>>(this.discoveryUrl(300));
      const items = Array.isArray(body.items) ? body.items : [];
      return {
        platform: this.id,
        status: "ok",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: `unified ready-to-earn inventory reachable; ${String(items.length)} opportunity/opportunities`,
      };
    } catch (error) {
      const typed = error instanceof CommerceError ? error : null;
      return {
        platform: this.id,
        status: "unreachable",
        checkedAt,
        latencyMs: Date.now() - started,
        detail: typed?.message ?? String(error),
        errorCode: typed?.code ?? "UPSTREAM_UNAVAILABLE",
      };
    }
  }

  public async discoverWork(query: WorkQuery, context: AdapterContext): Promise<WorkCandidate[]> {
    const requestedLimit = query.limit ?? 300;
    const url = this.discoveryUrl(requestedLimit);
    const body = await context.fetch.json<Record<string, unknown>>(url);
    if (!Array.isArray(body.items)) {
      throw new CommerceError("UPSTREAM_MALFORMED", "Agent Bounties discovery returned no items array");
    }

    const out: WorkCandidate[] = [];
    const legacy = isLegacyInventory(body);
    for (const raw of body.items) {
      if (raw === null || typeof raw !== "object") continue;
      const candidate = legacy
        ? normalizeBounty(raw as InventoryItem, context, url, this.network)
        : normalizeUnifiedOpportunity(raw, context, url, this.network);
      if (candidate === null) continue;
      out.push(candidate);
      if (query.limit !== undefined && out.length >= query.limit) break;
    }
    return out;
  }

  public async inspect(
    externalId: string,
    context: AdapterContext,
  ): Promise<import("../../core/models.js").InspectionResult> {
    const all = await this.discoverWork({}, context);
    const match = all.find((w) => w.externalId === externalId || w.id === externalId);
    if (match === undefined) throw new CommerceError("NOT_FOUND", `no Agent Bounties opportunity matched ${externalId}`);
    return {
      platform: this.id,
      externalId,
      inspectedAt: context.clock(),
      work: match,
      evidence: context.evidence.records(),
    };
  }

  public async prepareClaim(
    externalId: string,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    const inspection = await this.inspect(externalId, context);
    const work = inspection.work;
    if (work === undefined) throw new CommerceError("NOT_FOUND", `no claimable opportunity for ${externalId}`);
    return {
      platform: this.id,
      opportunityId: work.externalId,
      title: work.title,
      reward: work.reward,
      funding: work.funding,
      verification: work.verification,
      requirements: work.requirements,
      paymentProofRule: work.paymentProofRule ?? PAYMENT_PROOF_RULE,
      externalStepsRequired: [
        "re-fetch and inspect the exact canonical opportunity before any consequential action",
        "prepare only the platform-advertised next action and preserve all committed terms",
        "obtain explicit authorization before any wallet signature, claim, funding, proof or submission",
        "confirm canonical claim/entry evidence before starting work when the protocol requires it",
        "confirm the applicable canonical settlement event before treating payment as real",
      ],
      claimBroadcast: false,
      submissionBroadcast: false,
      signerPresent: false,
      blockedReason: "EXTERNAL_WRITE_DISABLED",
    };
  }

  private discoveryUrl(limit: number): string {
    return unifiedReadyToEarnUrl(this.baseUrl, this.network, limit);
  }
}
