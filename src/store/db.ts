/**
 * SQLite database connection and management.
 */

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, getMigrations } from "./migrations.js";

export type Row = Record<string, unknown>;

// ── Schema registry ──────────────────────────────────────────────────
// Allowlist of valid table names and their columns.
// This prevents SQL injection via interpolated identifiers.
const TABLE_SCHEMA: Record<string, ReadonlySet<string>> = {
  sessions: new Set([
    "id", "objective", "state", "started_at", "ended_at",
    "parent_session_id", "config_snapshot", "context_summary",
    "total_cost_usd", "total_input_tokens", "total_output_tokens",
    "metadata", "operator", "hostname", "k6s_version",
    "claude_code_version", "git_branch", "git_sha", "git_dirty",
    "trace_id",
  ]),
  agents: new Set([
    "id", "session_id", "name", "role", "specialization", "state",
    "spawned_at", "boundary_config", "metadata", "claude_session_id",
    "tool_call_count",
  ]),
  audit_events: new Set([
    "id", "sequence", "session_id", "agent_id", "timestamp",
    "event_type", "action", "details", "files_affected",
    "gate_id", "hmac", "severity",
  ]),
  gates: new Set([
    "id", "session_id", "rule_id", "rule_name", "agent_id", "state",
    "trigger_event_id", "triggered_at", "resolved_at",
    "resolved_by", "reason", "details",
  ]),
  cost_records: new Set([
    "id", "session_id", "agent_id", "task_id", "timestamp",
    "model", "input_tokens", "output_tokens", "estimated_cost_usd",
  ]),
  context_store: new Set([
    "key", "session_id", "agent_id", "value", "updated_at",
  ]),
  file_locks: new Set([
    "path", "session_id", "agent_id", "acquired_at", "expires_at",
  ]),
  boundary_violations: new Set([
    "id", "session_id", "agent_id", "timestamp", "file_path",
    "violation_type", "enforcement_action", "details",
  ]),
  schema_migrations: new Set(["version", "applied_at"]),
};

/** Only allow simple alphanumeric + underscore identifiers. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

export class Db {
  readonly path: string;
  private _db: Database.Database | null = null;

  constructor(dbPath: string) {
    this.path = dbPath;
  }

  // ── Identifier validation ────────────────────────────────────────
  // All methods that interpolate identifiers into SQL must call these
  // before building the query string.

  private assertValidTable(table: string): void {
    if (!TABLE_SCHEMA[table]) {
      throw new Error(`Db: unknown table "${table}"`);
    }
  }

  private assertValidColumns(table: string, columns: string[]): void {
    const schema = TABLE_SCHEMA[table];
    if (!schema) {
      throw new Error(`Db: unknown table "${table}"`);
    }
    for (const col of columns) {
      if (!SAFE_IDENTIFIER.test(col)) {
        throw new Error(`Db: unsafe column identifier "${col}"`);
      }
      if (!schema.has(col)) {
        throw new Error(`Db: unknown column "${col}" for table "${table}"`);
      }
    }
  }

  connect(): void {
    if (this._db) return;

    const dir = path.dirname(this.path);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);

    this._db = new Database(this.path);
    chmodSync(this.path, 0o600);

    this._db.pragma("journal_mode = WAL");
    this._db.pragma("busy_timeout = 5000");
    this._db.pragma("synchronous = FULL");
    this._db.pragma("foreign_keys = ON");

    this.runMigrations();
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  get db(): Database.Database {
    if (!this._db) {
      // Reconnect lazily if the handle was closed unexpectedly.
      this.connect();
    }
    if (!this._db) throw new Error("Database not connected");
    return this._db;
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const row = this.db
      .prepare("SELECT MAX(version) as max_version FROM schema_migrations")
      .get() as { max_version: number | null } | undefined;
    const currentVersion = row?.max_version ?? 0;

    for (const [version, sql] of getMigrations()) {
      if (version > currentVersion) {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version) VALUES (?)")
          .run(version);
      }
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  fetchOne(sql: string, params: unknown[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  fetchAll(sql: string, params: unknown[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  insert(table: string, data: Row): number | bigint {
    this.assertValidTable(table);
    const keys = Object.keys(data);
    this.assertValidColumns(table, keys);

    const columns = keys.join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
    const result = this.db.prepare(sql).run(...Object.values(data));
    return result.lastInsertRowid;
  }

  insertOrReplace(table: string, data: Row): void {
    this.assertValidTable(table);
    const keys = Object.keys(data);
    this.assertValidColumns(table, keys);

    const columns = keys.join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...Object.values(data));
  }

  update(
    table: string,
    data: Row,
    where: string,
    whereParams: unknown[],
  ): number {
    this.assertValidTable(table);
    const keys = Object.keys(data);
    this.assertValidColumns(table, keys);

    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${where}`;
    const result = this.db
      .prepare(sql)
      .run(...Object.values(data), ...whereParams);
    return result.changes;
  }

  delete(table: string, where: string, whereParams: unknown[]): number {
    this.assertValidTable(table);
    const sql = `DELETE FROM ${table} WHERE ${where}`;
    const result = this.db.prepare(sql).run(...whereParams);
    return result.changes;
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }
}

let _db: Db | null = null;

export function getDbPath(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return path.join(root, ".khoregos", "k6s.db");
}

export function getDatabase(projectRoot?: string): Db {
  if (!_db) {
    const dbPath = getDbPath(projectRoot);
    _db = new Db(dbPath);
    _db.connect();
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
