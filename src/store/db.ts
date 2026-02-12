/**
 * SQLite database connection and management.
 */

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, getMigrations } from "./migrations.js";

export type Row = Record<string, unknown>;

export class Db {
  readonly path: string;
  private _db: Database.Database | null = null;

  constructor(dbPath: string) {
    this.path = dbPath;
  }

  connect(): void {
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
    const columns = Object.keys(data).join(", ");
    const placeholders = Object.keys(data)
      .map(() => "?")
      .join(", ");
    const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
    const result = this.db.prepare(sql).run(...Object.values(data));
    return result.lastInsertRowid;
  }

  insertOrReplace(table: string, data: Row): void {
    const columns = Object.keys(data).join(", ");
    const placeholders = Object.keys(data)
      .map(() => "?")
      .join(", ");
    const sql = `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...Object.values(data));
  }

  update(
    table: string,
    data: Row,
    where: string,
    whereParams: unknown[],
  ): number {
    const setClause = Object.keys(data)
      .map((k) => `${k} = ?`)
      .join(", ");
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${where}`;
    const result = this.db
      .prepare(sql)
      .run(...Object.values(data), ...whereParams);
    return result.changes;
  }

  delete(table: string, where: string, whereParams: unknown[]): number {
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
