/** Typed persistence for canonical commerce state. */
import { canonicalJson } from "../core/ids.js";
import type {
  EvidenceRecord,
  PlatformId,
  ProbeResult,
  Quote,
  ServiceCandidate,
  SourceObservation,
  WorkCandidate,
} from "../core/models.js";
import { parseServiceCandidate, parseWorkCandidate } from "../core/schemas.js";
import { sanitize, sanitizeText } from "../evidence/sanitize.js";
import type { PolicyDecision } from "../policy/decisions.js";
import { withTransaction, type StateDatabase } from "./sqlite.js";

export interface OperationRecord {
  readonly id: string;
  readonly type: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly mode: "A";
  readonly sourcesRequested?: number | undefined;
  readonly sourcesSucceeded?: number | undefined;
  readonly sourcesFailed?: number | undefined;
  readonly resultCount?: number | undefined;
  readonly financialActionExecuted: boolean;
  readonly externalMutationExecuted: boolean;
  readonly evidencePaths?: readonly string[] | undefined;
  readonly errors?: readonly string[] | undefined;
}

export interface IntentRecord {
  readonly id: string;
  readonly kind: string;
  readonly platform: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly hash: string;
  readonly body: unknown;
  readonly decisionRule: string;
  readonly decisionOutcome: string;
  readonly financialActionExecuted: boolean;
  readonly externalMutationExecuted: boolean;
}

export interface ExportRecord {
  readonly path: string;
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly exportedAt: string;
}

const bool = (v: boolean): number => (v ? 1 : 0);
const safeJson = (value: unknown): string => canonicalJson(sanitize(value));
const safeText = (value: string): string => sanitizeText(value);
const safeOptionalText = (value: string | undefined): string | null =>
  value === undefined ? null : safeText(value);
const safeNullableText = (value: string | null): string | null =>
  value === null ? null : safeText(value);

export class CommerceRepository {
  public constructor(private readonly db: StateDatabase) {}

  public saveService(service: ServiceCandidate): void {
    const safeService = parseServiceCandidate(sanitize(service));
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO services (
             id, name, resource_url, method, protocol, network, pay_to,
             price_atomic, price_decimal, currency, health, observed_at, snapshot
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             health = excluded.health,
             observed_at = excluded.observed_at,
             price_atomic = excluded.price_atomic,
             price_decimal = excluded.price_decimal,
             currency = excluded.currency,
             snapshot = excluded.snapshot`,
        )
        .run(
          safeService.id,
          safeService.name,
          safeService.resourceUrl,
          safeService.method,
          safeService.protocol,
          safeService.network ?? null,
          safeService.payTo ?? null,
          safeService.price?.atomic ?? null,
          safeService.price?.decimal ?? null,
          safeService.price?.currency ?? null,
          safeService.health,
          safeService.observedAt,
          canonicalJson(safeService),
        );

      const insertObs = this.db.prepare(
        `INSERT INTO service_observations (service_id, source, external_id, observed_at, source_url)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (service_id, source, external_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           source_url = excluded.source_url`,
      );
      for (const obs of safeService.sources) {
        insertObs.run(
          safeService.id,
          obs.source,
          obs.externalId,
          obs.observedAt,
          obs.sourceUrl ?? null,
        );
      }
    });
  }

  public getService(id: string): ServiceCandidate | null {
    const row = this.db.prepare("SELECT snapshot FROM services WHERE id = ?").get(id) as
      | { snapshot: string }
      | undefined;
    return row === undefined ? null : parseServiceCandidate(JSON.parse(row.snapshot));
  }

  public listServices(limit = 500): ServiceCandidate[] {
    const rows = this.db
      .prepare("SELECT snapshot FROM services ORDER BY observed_at DESC, id ASC LIMIT ?")
      .all(limit) as Array<{ snapshot: string }>;
    return rows.map((row) => parseServiceCandidate(JSON.parse(row.snapshot)));
  }

  public listServiceObservations(serviceId: string): SourceObservation[] {
    const rows = this.db
      .prepare(
        `SELECT source, external_id, observed_at, source_url
         FROM service_observations WHERE service_id = ? ORDER BY source ASC`,
      )
      .all(serviceId) as Array<{
      source: string;
      external_id: string;
      observed_at: string;
      source_url: string | null;
    }>;
    return rows.map((row) => ({
      source: row.source as PlatformId,
      externalId: row.external_id,
      observedAt: row.observed_at,
      sourceUrl: row.source_url ?? undefined,
    }));
  }

  public saveWork(work: WorkCandidate): void {
    const safeWork = parseWorkCandidate(sanitize(work));
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO work_items (
             id, source, external_id, title, reward_amount, reward_asset, reward_network,
             funding_state, funding_evidence, verifier_type, status, deadline, observed_at, snapshot
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             title = excluded.title,
             reward_amount = excluded.reward_amount,
             funding_state = excluded.funding_state,
             funding_evidence = excluded.funding_evidence,
             verifier_type = excluded.verifier_type,
             status = excluded.status,
             deadline = excluded.deadline,
             observed_at = excluded.observed_at,
             snapshot = excluded.snapshot`,
        )
        .run(
          safeWork.id,
          safeWork.source,
          safeWork.externalId,
          safeWork.title,
          safeWork.reward.amount,
          safeWork.reward.asset,
          safeWork.reward.network ?? null,
          safeWork.funding.state,
          safeWork.funding.evidence,
          safeWork.verification.type,
          safeWork.status,
          safeWork.deadline ?? null,
          safeWork.observedAt,
          canonicalJson(safeWork),
        );

      this.db
        .prepare(
          `INSERT INTO work_observations (work_id, source, external_id, observed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (work_id, source, external_id, observed_at) DO NOTHING`,
        )
        .run(safeWork.id, safeWork.source, safeWork.externalId, safeWork.observedAt);
    });
  }

  public getWork(id: string): WorkCandidate | null {
    const row = this.db.prepare("SELECT snapshot FROM work_items WHERE id = ?").get(id) as
      | { snapshot: string }
      | undefined;
    return row === undefined ? null : parseWorkCandidate(JSON.parse(row.snapshot));
  }

  public listWork(limit = 500): WorkCandidate[] {
    const rows = this.db
      .prepare("SELECT snapshot FROM work_items ORDER BY observed_at DESC, id ASC LIMIT ?")
      .all(limit) as Array<{ snapshot: string }>;
    return rows.map((row) => parseWorkCandidate(JSON.parse(row.snapshot)));
  }

  public saveQuote(quote: Quote): void {
    this.db
      .prepare(
        `INSERT INTO quotes (
           service_id, platform, quoted_at, price_atomic, price_decimal, currency,
           network, executable, snapshot
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.serviceId,
        quote.platform,
        quote.quotedAt,
        safeOptionalText(quote.price?.atomic),
        safeOptionalText(quote.price?.decimal),
        safeOptionalText(quote.price?.currency),
        safeOptionalText(quote.network),
        bool(false),
        safeJson(quote),
      );
  }

  public saveProbe(probe: ProbeResult): void {
    this.db
      .prepare(
        `INSERT INTO probes (platform, status, checked_at, latency_ms, detail, error_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        probe.platform,
        probe.status,
        probe.checkedAt,
        probe.latencyMs ?? null,
        safeOptionalText(probe.detail),
        safeOptionalText(probe.errorCode),
      );
  }

  public listProbes(platform?: PlatformId, limit = 100): ProbeResult[] {
    const rows = (
      platform === undefined
        ? this.db.prepare("SELECT * FROM probes ORDER BY checked_at DESC LIMIT ?").all(limit)
        : this.db
            .prepare("SELECT * FROM probes WHERE platform = ? ORDER BY checked_at DESC LIMIT ?")
            .all(platform, limit)
    ) as Array<{
      platform: string;
      status: string;
      checked_at: string;
      latency_ms: number | null;
      detail: string | null;
      error_code: string | null;
    }>;
    return rows.map((row) => ({
      platform: row.platform as PlatformId,
      status: row.status as ProbeResult["status"],
      checkedAt: row.checked_at,
      latencyMs: row.latency_ms ?? undefined,
      detail: row.detail ?? undefined,
      errorCode: row.error_code ?? undefined,
    }));
  }

  public saveEvidence(record: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence (
           platform, fact, value, classification, source_type, source_ref, captured_at, hash, raw_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.platform,
        safeText(record.fact),
        safeText(record.value),
        record.classification,
        safeText(record.sourceType),
        safeText(record.sourceRef),
        record.capturedAt,
        record.hash,
        safeOptionalText(record.rawPath),
      );
  }

  public savePolicyDecision(decision: PolicyDecision): void {
    this.db
      .prepare(
        `INSERT INTO policy_decisions (
           operation, class, decision, rule, reason, required_activation, mode, evaluated_at, detail
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        safeText(decision.operation),
        decision.class,
        decision.decision,
        safeText(decision.rule),
        safeNullableText(decision.reason),
        safeNullableText(decision.requiredActivation),
        decision.mode,
        decision.evaluatedAt,
        safeText(decision.detail),
      );
  }

  public saveIntent(intent: IntentRecord): void {
    this.db
      .prepare(
        `INSERT INTO intents (
           id, kind, platform, target_id, created_at, hash, body,
           decision_rule, decision_outcome, financial_action_executed, external_mutation_executed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        intent.id,
        safeText(intent.kind),
        safeText(intent.platform),
        safeText(intent.targetId),
        intent.createdAt,
        intent.hash,
        safeJson(intent.body),
        safeText(intent.decisionRule),
        safeText(intent.decisionOutcome),
        bool(intent.financialActionExecuted),
        bool(intent.externalMutationExecuted),
      );
  }

  public listIntents(limit = 100): IntentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM intents ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      platform: String(row.platform),
      targetId: String(row.target_id),
      createdAt: String(row.created_at),
      hash: String(row.hash),
      body: JSON.parse(String(row.body)),
      decisionRule: String(row.decision_rule),
      decisionOutcome: String(row.decision_outcome),
      financialActionExecuted: Number(row.financial_action_executed) === 1,
      externalMutationExecuted: Number(row.external_mutation_executed) === 1,
    }));
  }

  public saveOperation(op: OperationRecord): void {
    this.db
      .prepare(
        `INSERT INTO operations (
           id, type, started_at, ended_at, mode, sources_requested, sources_succeeded,
           sources_failed, result_count, financial_action_executed,
           external_mutation_executed, evidence_paths, errors
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           ended_at = excluded.ended_at,
           result_count = excluded.result_count,
           evidence_paths = excluded.evidence_paths,
           errors = excluded.errors`,
      )
      .run(
        op.id,
        safeText(op.type),
        op.startedAt,
        op.endedAt ?? null,
        op.mode,
        op.sourcesRequested ?? 0,
        op.sourcesSucceeded ?? 0,
        op.sourcesFailed ?? 0,
        op.resultCount ?? 0,
        bool(op.financialActionExecuted),
        bool(op.externalMutationExecuted),
        op.evidencePaths === undefined ? null : safeJson(op.evidencePaths),
        op.errors === undefined ? null : safeJson(op.errors),
      );
  }

  public getOperation(id: string): OperationRecord | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return {
      id: String(row.id),
      type: String(row.type),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? undefined : String(row.ended_at),
      mode: "A",
      sourcesRequested: Number(row.sources_requested),
      sourcesSucceeded: Number(row.sources_succeeded),
      sourcesFailed: Number(row.sources_failed),
      resultCount: Number(row.result_count),
      financialActionExecuted: Number(row.financial_action_executed) === 1,
      externalMutationExecuted: Number(row.external_mutation_executed) === 1,
      evidencePaths:
        row.evidence_paths === null
          ? undefined
          : (JSON.parse(String(row.evidence_paths)) as string[]),
      errors: row.errors === null ? undefined : (JSON.parse(String(row.errors)) as string[]),
    };
  }

  public saveExport(record: ExportRecord): void {
    this.db
      .prepare(
        `INSERT INTO exports (path, kind, sha256, bytes, exported_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        safeText(record.path),
        safeText(record.kind),
        record.sha256,
        record.bytes,
        record.exportedAt,
      );
  }

  public upsertSource(platform: PlatformId, enabled: boolean, baseUrl: string, status?: string): void {
    this.db
      .prepare(
        `INSERT INTO sources (platform, enabled, base_url, last_status, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (platform) DO UPDATE SET
           enabled = excluded.enabled,
           base_url = excluded.base_url,
           last_status = excluded.last_status,
           last_seen = excluded.last_seen`,
      )
      .run(
        platform,
        bool(enabled),
        safeText(baseUrl),
        safeOptionalText(status),
        new Date().toISOString(),
      );
  }
}
