/**
 * Tests for Db: schema validation, CRUD, transactions, migrations.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db, getDbPath } from "../../src/store/db.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import { sessionToDbRow } from "../../src/models/session.js";
import type { Session } from "../../src/models/session.js";
import { ulid } from "ulid";

describe("Db", () => {
  let db: Db;
  let dbPath: string;

  beforeAll(() => {
    dbPath = getTempDbPath();
    db = new Db(dbPath);
    db.connect();
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  describe("connect and schema", () => {
    it("exposes schema version from migrations", () => {
      expect(db.schemaVersion).toBeGreaterThanOrEqual(1);
    });

    it("creates schema_migrations table and applies migrations", () => {
      const row = db.fetchOne(
        "SELECT MAX(version) as v FROM schema_migrations",
      );
      expect(row?.v).toBe(db.schemaVersion);
    });

    it("includes tool_call_count column on agents table", () => {
      const rows = db.fetchAll("PRAGMA table_info(agents)");
      const names = rows.map((r) => String(r.name));
      expect(names).toContain("tool_call_count");
    });

    it("allows connect to be called repeatedly", () => {
      expect(() => db.connect()).not.toThrow();
      const row = db.fetchOne("SELECT 1 as v");
      expect(row?.v).toBe(1);
    });

    it("reconnects lazily after close on first query", () => {
      db.close();
      const row = db.fetchOne("SELECT 2 as v");
      expect(row?.v).toBe(2);
    });
  });

  describe("insert", () => {
    it("inserts a row and returns lastInsertRowid", () => {
      const session: Session = {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        objective: "test objective",
        state: "created",
        startedAt: new Date().toISOString(),
        endedAt: null,
        parentSessionId: null,
        configSnapshot: null,
        contextSummary: null,
        metadata: null,
        operator: null,
        hostname: null,
        k6sVersion: null,
        claudeCodeVersion: null,
        gitBranch: null,
        gitSha: null,
        gitDirty: false,
        traceId: null,
      };
      const id = db.insert("sessions", sessionToDbRow(session));
      expect(id).toBeDefined();
    });

    it("rejects unknown table", () => {
      expect(() =>
        db.insert("unknown_table", { id: "x" }),
      ).toThrow(/unknown table/);
    });

    it("rejects unknown column for known table", () => {
      expect(() =>
        db.insert("sessions", {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          objective: "x",
          state: "created",
          started_at: new Date().toISOString(),
          invalid_column: "y",
        } as Record<string, unknown>),
      ).toThrow(/unknown column/);
    });

    it("rejects unsafe column identifier", () => {
      expect(() =>
        db.insert("sessions", {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
          objective: "x",
          state: "created",
          started_at: new Date().toISOString(),
          "evil; DROP TABLE sessions;--": "z",
        } as Record<string, unknown>),
      ).toThrow(/unsafe column|unknown column/);
    });
  });

  describe("fetchOne and fetchAll", () => {
    it("fetchOne returns undefined when no row", () => {
      const row = db.fetchOne(
        "SELECT * FROM sessions WHERE id = ?",
        ["nonexistent"],
      );
      expect(row).toBeUndefined();
    });

    it("fetchOne returns row when present", () => {
      const row = db.fetchOne(
        "SELECT id, objective, state FROM sessions WHERE objective = ?",
        ["test objective"],
      );
      expect(row).toBeDefined();
      expect(row?.objective).toBe("test objective");
      expect(row?.state).toBe("created");
    });

    it("fetchAll returns array of rows", () => {
      const rows = db.fetchAll(
        "SELECT id FROM sessions ORDER BY started_at LIMIT 5",
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it("fetchAll with params works", () => {
      const rows = db.fetchAll(
        "SELECT id FROM sessions WHERE state = ?",
        ["created"],
      );
      expect(rows.some((r) => r.id)).toBe(true);
    });
  });

  describe("update", () => {
    it("updates rows and returns changes count", () => {
      const n = db.update(
        "sessions",
        { state: "active" },
        "objective = ?",
        ["test objective"],
      );
      expect(n).toBeGreaterThanOrEqual(1);
    });

    it("rejects unknown table on update", () => {
      expect(() =>
        db.update(
          "unknown_table",
          { x: "y" },
          "id = ?",
          ["z"],
        ),
      ).toThrow(/unknown table/);
    });
  });

  describe("delete", () => {
    it("deletes rows and returns changes count", () => {
      const before = db.fetchAll("SELECT id FROM sessions WHERE objective = ?", [
        "test objective",
      ]);
      const n = db.delete("sessions", "objective = ?", ["test objective"]);
      expect(n).toBe(before.length);
    });

    it("rejects unknown table on delete", () => {
      expect(() =>
        db.delete("unknown_table", "id = ?", ["x"]),
      ).toThrow(/unknown table/);
    });
  });

  describe("insertOrReplace", () => {
    it("inserts or replaces row", () => {
      const sessionIdForContext = ulid();
      db.insert("sessions", sessionToDbRow({
        id: sessionIdForContext,
        objective: "context insert test",
        state: "created",
        startedAt: new Date().toISOString(),
        endedAt: null,
        parentSessionId: null,
        configSnapshot: null,
        contextSummary: null,
        metadata: null,
        operator: null,
        hostname: null,
        k6sVersion: null,
        claudeCodeVersion: null,
        gitBranch: null,
        gitSha: null,
        gitDirty: false,
        traceId: null,
      }));
      const key = "test-key-" + Date.now();
      db.insertOrReplace("context_store", {
        key,
        session_id: sessionIdForContext,
        agent_id: null,
        value: "v1",
        updated_at: new Date().toISOString(),
      });
      let row = db.fetchOne(
        "SELECT value FROM context_store WHERE key = ?",
        [key],
      );
      expect(row?.value).toBe("v1");
      db.insertOrReplace("context_store", {
        key,
        session_id: sessionIdForContext,
        agent_id: null,
        value: "v2",
        updated_at: new Date().toISOString(),
      });
      row = db.fetchOne(
        "SELECT value FROM context_store WHERE key = ?",
        [key],
      );
      expect(row?.value).toBe("v2");
      db.delete("context_store", "key = ?", [key]);
    });
  });

  describe("transaction", () => {
    it("runs fn in a transaction and returns value", () => {
      const result = db.transaction(() => {
        const r = db.fetchOne("SELECT COUNT(*) as c FROM sessions");
        return (r?.c as number) ?? 0;
      });
      expect(typeof result).toBe("number");
    });

    it("rolls back on throw", () => {
      const txSessionId = ulid();
      const sessionRow = sessionToDbRow({
        id: txSessionId,
        objective: "tx test",
        state: "created",
        startedAt: new Date().toISOString(),
        endedAt: null,
        parentSessionId: null,
        configSnapshot: null,
        contextSummary: null,
        metadata: null,
        operator: null,
        hostname: null,
        k6sVersion: null,
        claudeCodeVersion: null,
        gitBranch: null,
        gitSha: null,
        gitDirty: false,
        traceId: null,
      });
      expect(() =>
        db.transaction(() => {
          db.insert("sessions", sessionRow);
          throw new Error("abort");
        }),
      ).toThrow("abort");
      const row = db.fetchOne("SELECT id FROM sessions WHERE id = ?", [
        txSessionId,
      ]);
      expect(row).toBeUndefined();
    });
  });
});

describe("getDbPath", () => {
  afterAll(() => cleanupTempDir());

  it("returns path under .khoregos when no projectRoot", () => {
    const p = getDbPath();
    expect(p).toContain(".khoregos");
    expect(p).toMatch(/k6s\.db$/);
  });

  it("returns path under given projectRoot", () => {
    const root = "/tmp/my-project";
    const p = getDbPath(root);
    expect(p).toBe("/tmp/my-project/.khoregos/k6s.db");
  });
});
