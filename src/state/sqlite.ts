/**
 * Built-in SQLite access.
 *
 * Uses `node:sqlite` (`DatabaseSync`) rather than a native npm addon. This is a
 * deliberate choice for the native Android/Termux target: there is no compile
 * step, no prebuilt-binary lookup that can miss `android-arm64`, and no Docker
 * requirement. Node 24.18 on this runtime provides `DatabaseSync` directly.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CommerceError } from "../core/errors.js";

export type StateDatabase = DatabaseSync;

/**
 * Opens (creating if needed) the state database with safe pragmas.
 *
 * Extension loading is never enabled: nothing in this control plane needs it,
 * and leaving it off removes an arbitrary-code-execution surface that untrusted
 * marketplace data must never be able to reach.
 */
export function openStateDatabase(path: string): StateDatabase {
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  } catch (cause) {
    throw new CommerceError("STATE_ERROR", `cannot create state directory for ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let db: DatabaseSync;
  try {
    // allowExtension defaults to false; passed explicitly to make the intent
    // auditable rather than implicit.
    db = new DatabaseSync(path, { allowExtension: false });
  } catch (cause) {
    throw new CommerceError("STATE_ERROR", `cannot open state database at ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  // Durability and concurrency pragmas. WAL is attempted but not required:
  // some Android filesystem/mount combinations reject it, and falling back to
  // the default journal mode is correct behaviour rather than a fatal error.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Fall through on the default journal mode.
  }
  db.exec("PRAGMA synchronous = NORMAL");

  return db;
}

export function closeStateDatabase(db: StateDatabase): void {
  try {
    db.close();
  } catch {
    // Already closed; closing twice is not an error worth propagating.
  }
}

/**
 * Runs a function inside an IMMEDIATE transaction, rolling back on throw.
 *
 * Used where a receipt and its evidence references must land together: a
 * half-written receipt is worse than no receipt.
 */
export function withTransaction<T>(db: StateDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback failure must not mask the original error.
    }
    throw error;
  }
}
