/**
 * Shared CLI utilities used by multiple command modules.
 */

import path from "node:path";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";

/**
 * Open the project's k6s database, run a callback, and close it.
 * Guarantees the database is closed even if the callback throws.
 */
export function withDb<T>(projectRoot: string, fn: (db: Db) => T): T {
  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Resolve a session ID string: "latest" becomes the most recent session ID,
 * anything else is passed through as-is.
 */
export function resolveSessionId(
  sm: StateManager,
  session: string,
): string | null {
  if (session === "latest") {
    const latest = sm.getLatestSession();
    return latest?.id ?? null;
  }
  return session;
}
