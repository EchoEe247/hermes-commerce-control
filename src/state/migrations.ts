/**
 * Versioned, idempotent migrations.
 *
 * Each migration runs at most once, recorded in `schema_migrations`. Re-running
 * `runMigrations` on an up-to-date database applies nothing, which is what makes
 * restart and recovery safe: the installer, the doctor and every CLI invocation
 * can call it unconditionally.
 *
 * Identity, status and timestamp columns stay searchable; large normalized
 * snapshots live in a JSON text column. No column ever holds an auth header,
 * token or other credential.
 */
import { withTransaction, type StateDatabase } from "./sqlite.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initial_schema",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version     INTEGER PRIMARY KEY,
         name        TEXT NOT NULL,
         applied_at  TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS sources (
         platform    TEXT PRIMARY KEY,
         enabled     INTEGER NOT NULL DEFAULT 1,
         base_url    TEXT NOT NULL,
         last_status TEXT,
         last_seen   TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS services (
         id            TEXT PRIMARY KEY,
         name          TEXT NOT NULL,
         resource_url  TEXT NOT NULL,
         method        TEXT NOT NULL,
         protocol      TEXT NOT NULL,
         network       TEXT,
         pay_to        TEXT,
         price_atomic  TEXT,
         price_decimal TEXT,
         currency      TEXT,
         health        TEXT NOT NULL,
         observed_at   TEXT NOT NULL,
         snapshot      TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_services_observed_at ON services (observed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_services_network ON services (network)`,
      `CREATE TABLE IF NOT EXISTS service_observations (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         service_id  TEXT NOT NULL REFERENCES services (id) ON DELETE CASCADE,
         source      TEXT NOT NULL,
         external_id TEXT NOT NULL,
         observed_at TEXT NOT NULL,
         source_url  TEXT,
         UNIQUE (service_id, source, external_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_service_obs_source ON service_observations (source)`,
      `CREATE TABLE IF NOT EXISTS work_items (
         id               TEXT PRIMARY KEY,
         source           TEXT NOT NULL,
         external_id      TEXT NOT NULL,
         title            TEXT NOT NULL,
         reward_amount    TEXT NOT NULL,
         reward_asset     TEXT NOT NULL,
         reward_network   TEXT,
         funding_state    TEXT NOT NULL,
         funding_evidence TEXT NOT NULL,
         verifier_type    TEXT NOT NULL,
         status           TEXT NOT NULL,
         deadline         TEXT,
         observed_at      TEXT NOT NULL,
         snapshot         TEXT NOT NULL,
         UNIQUE (source, external_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_work_status ON work_items (status)`,
      `CREATE INDEX IF NOT EXISTS idx_work_funding ON work_items (funding_state)`,
      `CREATE TABLE IF NOT EXISTS work_observations (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         work_id     TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
         source      TEXT NOT NULL,
         external_id TEXT NOT NULL,
         observed_at TEXT NOT NULL,
         UNIQUE (work_id, source, external_id, observed_at)
       )`,
      `CREATE TABLE IF NOT EXISTS quotes (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         service_id   TEXT NOT NULL,
         platform     TEXT NOT NULL,
         quoted_at    TEXT NOT NULL,
         price_atomic TEXT,
         price_decimal TEXT,
         currency     TEXT,
         network      TEXT,
         executable   INTEGER NOT NULL DEFAULT 0,
         snapshot     TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_quotes_service ON quotes (service_id)`,
      `CREATE TABLE IF NOT EXISTS intents (
         id                          TEXT PRIMARY KEY,
         kind                        TEXT NOT NULL,
         platform                    TEXT NOT NULL,
         target_id                   TEXT NOT NULL,
         created_at                  TEXT NOT NULL,
         hash                        TEXT NOT NULL,
         body                        TEXT NOT NULL,
         decision_rule               TEXT NOT NULL,
         decision_outcome            TEXT NOT NULL,
         financial_action_executed   INTEGER NOT NULL DEFAULT 0,
         external_mutation_executed  INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_intents_kind ON intents (kind)`,
      `CREATE TABLE IF NOT EXISTS policy_decisions (
         id                  INTEGER PRIMARY KEY AUTOINCREMENT,
         operation           TEXT NOT NULL,
         class               TEXT NOT NULL,
         decision            TEXT NOT NULL,
         rule                TEXT NOT NULL,
         reason              TEXT,
         required_activation TEXT,
         mode                TEXT NOT NULL,
         evaluated_at        TEXT NOT NULL,
         detail              TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_policy_decisions_at ON policy_decisions (evaluated_at)`,
      `CREATE TABLE IF NOT EXISTS probes (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         platform   TEXT NOT NULL,
         status     TEXT NOT NULL,
         checked_at TEXT NOT NULL,
         latency_ms INTEGER,
         detail     TEXT,
         error_code TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_probes_platform ON probes (platform, checked_at)`,
      `CREATE TABLE IF NOT EXISTS evidence (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         platform       TEXT NOT NULL,
         fact           TEXT NOT NULL,
         value          TEXT NOT NULL,
         classification TEXT NOT NULL,
         source_type    TEXT NOT NULL,
         source_ref     TEXT NOT NULL,
         captured_at    TEXT NOT NULL,
         hash           TEXT NOT NULL,
         raw_path       TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_hash ON evidence (hash)`,
      `CREATE TABLE IF NOT EXISTS exports (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         path        TEXT NOT NULL,
         kind        TEXT NOT NULL,
         sha256      TEXT NOT NULL,
         bytes       INTEGER NOT NULL,
         exported_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS operations (
         id                         TEXT PRIMARY KEY,
         type                       TEXT NOT NULL,
         started_at                 TEXT NOT NULL,
         ended_at                   TEXT,
         mode                       TEXT NOT NULL,
         sources_requested          INTEGER NOT NULL DEFAULT 0,
         sources_succeeded          INTEGER NOT NULL DEFAULT 0,
         sources_failed             INTEGER NOT NULL DEFAULT 0,
         result_count               INTEGER NOT NULL DEFAULT 0,
         financial_action_executed  INTEGER NOT NULL DEFAULT 0,
         external_mutation_executed INTEGER NOT NULL DEFAULT 0,
         evidence_paths             TEXT,
         errors                     TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_operations_type ON operations (type, started_at)`,
    ]),
  },
]);

export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

export interface MigrationOutcome {
  readonly applied: readonly number[];
  readonly appliedTo: number;
}

/** Applies any migration whose version is not yet recorded. Safe to re-run. */
export function runMigrations(db: StateDatabase): MigrationOutcome {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     INTEGER PRIMARY KEY,
       name        TEXT NOT NULL,
       applied_at  TEXT NOT NULL
     )`,
  );

  const existing = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (existing.has(migration.version)) continue;
    withTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    applied.push(migration.version);
  }

  return { applied, appliedTo: currentSchemaVersion() };
}
