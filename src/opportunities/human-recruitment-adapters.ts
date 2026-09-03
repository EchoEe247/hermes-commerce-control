import { canonicalHash } from "../core/ids.js";
import {
  HUMAN_RECRUITMENT_CHANNELS,
  type HumanFulfillmentContractDraft,
  type HumanRecruitmentChannel,
} from "./human-fulfillment.js";

export const HUMAN_RECRUITMENT_DELIVERY_KINDS = ["public_post", "private_message"] as const;
export type HumanRecruitmentDeliveryKind = (typeof HUMAN_RECRUITMENT_DELIVERY_KINDS)[number];

export interface HumanRecruitmentTarget {
  readonly channel: HumanRecruitmentChannel;
  readonly target: string;
  readonly rulesVerifiedAt: string;
  readonly delivery?: HumanRecruitmentDeliveryKind | undefined;
}

export interface HumanRecruitmentPayload {
  readonly schemaVersion: 1;
  readonly payloadId: string;
  readonly contractId: string;
  readonly recruitmentDraftId: string;
  readonly opportunityId: string;
  readonly channel: HumanRecruitmentChannel;
  readonly target: string;
  readonly delivery: HumanRecruitmentDeliveryKind;
  readonly rulesVerifiedAt: string;
  readonly workerTerms: {
    readonly kind: "remote" | "physical";
    readonly taskBrief: string;
    readonly acceptanceCriteria: readonly string[];
    readonly evidenceRequirements: readonly string[];
    readonly fullCompensationUsd: number;
    readonly goodFaithAttemptCompensationUsd: number;
    readonly dueAt?: string | undefined;
  };
  readonly rendered: {
    readonly title: string;
    readonly body: string;
  };
  readonly boundary: {
    readonly externalActionsAllowed: false;
    readonly preparedContentOnly: true;
    readonly compensationExecutionAllowed: false;
  };
}

function assertTimestamp(name: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid timestamp`);
}

function boundedText(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} must not be empty`);
  if (normalized.length > max) throw new Error(`${name} exceeds ${String(max)} characters`);
  return normalized;
}

function defaultDelivery(channel: HumanRecruitmentChannel): HumanRecruitmentDeliveryKind {
  return channel === "direct" ? "private_message" : "public_post";
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function taskLabel(kind: "remote" | "physical"): string {
  return kind === "physical" ? "Paid local/physical task" : "Paid remote task";
}

function linesForTerms(contract: HumanFulfillmentContractDraft): readonly string[] {
  const terms = contract.terms;
  const lines = [
    `Scope: ${terms.taskBrief}`,
    `Full compensation after accepted completion: ${money(terms.fullCompensationUsd)}.`,
    `Pre-agreed compensation for a documented good-faith attempt that fails acceptance: ${money(terms.goodFaithAttemptCompensationUsd)}.`,
    "Acceptance criteria:",
    ...terms.acceptanceCriteria.map((item) => `- ${item}`),
    "Evidence required:",
    ...terms.evidenceRequirements.map((item) => `- ${item}`),
  ];
  if (terms.dueAt !== undefined) lines.push(`Due by: ${terms.dueAt}`);
  lines.push("Do not begin until the exact terms are confirmed with you directly.");
  return Object.freeze(lines);
}

function renderReddit(contract: HumanFulfillmentContractDraft): HumanRecruitmentPayload["rendered"] {
  const title = boundedText(
    "reddit title",
    `[HIRING] ${taskLabel(contract.kind)} — ${money(contract.terms.fullCompensationUsd)}`,
    300,
  );
  return Object.freeze({
    title,
    body: linesForTerms(contract).join("\n\n"),
  });
}

function renderMarketplace(contract: HumanFulfillmentContractDraft): HumanRecruitmentPayload["rendered"] {
  return Object.freeze({
    title: boundedText(
      "marketplace title",
      `${taskLabel(contract.kind)} — ${money(contract.terms.fullCompensationUsd)}`,
      300,
    ),
    body: linesForTerms(contract).join("\n"),
  });
}

function renderDirect(contract: HumanFulfillmentContractDraft): HumanRecruitmentPayload["rendered"] {
  return Object.freeze({
    title: boundedText("direct subject", taskLabel(contract.kind), 300),
    body: [
      `I have a ${contract.kind} paid task that may fit you.`,
      ...linesForTerms(contract),
      "If you are interested, reply with availability and any questions before accepting.",
    ].join("\n\n"),
  });
}

function renderOther(contract: HumanFulfillmentContractDraft): HumanRecruitmentPayload["rendered"] {
  return Object.freeze({
    title: boundedText("custom title", `${taskLabel(contract.kind)} — ${money(contract.terms.fullCompensationUsd)}`, 300),
    body: linesForTerms(contract).join("\n"),
  });
}

function renderForChannel(
  channel: HumanRecruitmentChannel,
  contract: HumanFulfillmentContractDraft,
): HumanRecruitmentPayload["rendered"] {
  switch (channel) {
    case "reddit":
      return renderReddit(contract);
    case "marketplace":
      return renderMarketplace(contract);
    case "direct":
      return renderDirect(contract);
    case "other":
      return renderOther(contract);
  }
}

/**
 * Convert frozen worker terms into a channel-specific payload without invoking
 * the channel. Internal upstream economics, source listing text, ranking/model
 * metadata, and worker payment machinery are intentionally absent.
 */
export function buildHumanRecruitmentPayload(
  contract: HumanFulfillmentContractDraft,
  target: HumanRecruitmentTarget,
): HumanRecruitmentPayload {
  if (!(HUMAN_RECRUITMENT_CHANNELS as readonly string[]).includes(target.channel)) {
    throw new Error(`unsupported human recruitment channel ${JSON.stringify(target.channel)}`);
  }
  if (!contract.financial.paymentAuthorizationReady) {
    throw new Error(
      `worker-facing recruitment requires a positive economic case: ${contract.financial.blockers.join("; ")}`,
    );
  }
  const normalizedTarget = boundedText("recruitment target", target.target, 1_024);
  assertTimestamp("rulesVerifiedAt", target.rulesVerifiedAt);
  const delivery = target.delivery ?? defaultDelivery(target.channel);
  if (target.channel === "direct" && delivery !== "private_message") {
    throw new Error("direct recruitment must use private_message delivery");
  }
  const rendered = renderForChannel(target.channel, contract);
  const payloadId = `hpayload_${canonicalHash({
    schemaVersion: 1,
    contractId: contract.contractId,
    channel: target.channel,
    target: normalizedTarget,
    delivery,
    rulesVerifiedAt: target.rulesVerifiedAt,
    rendered,
  }).slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: 1 as const,
    payloadId,
    contractId: contract.contractId,
    recruitmentDraftId: contract.recruitmentDraftId,
    opportunityId: contract.opportunityId,
    channel: target.channel,
    target: normalizedTarget,
    delivery,
    rulesVerifiedAt: target.rulesVerifiedAt,
    workerTerms: Object.freeze({
      kind: contract.kind,
      taskBrief: contract.terms.taskBrief,
      acceptanceCriteria: contract.terms.acceptanceCriteria,
      evidenceRequirements: contract.terms.evidenceRequirements,
      fullCompensationUsd: contract.terms.fullCompensationUsd,
      goodFaithAttemptCompensationUsd: contract.terms.goodFaithAttemptCompensationUsd,
      ...(contract.terms.dueAt === undefined ? {} : { dueAt: contract.terms.dueAt }),
    }),
    rendered,
    boundary: Object.freeze({
      externalActionsAllowed: false as const,
      preparedContentOnly: true as const,
      compensationExecutionAllowed: false as const,
    }),
  });
}
