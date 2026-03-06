/**
 * Tests for migration v6: cost_records extensions and transcript_offset.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("migration v6", () => {
  let db: Db;

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("adds cache_creation_input_tokens column to cost_records", () => {
    const info = db.db
      .prepare("PRAGMA table_info(cost_records)")
      .all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("cache_creation_input_tokens");
  });

  it("adds cache_read_input_tokens column to cost_records", () => {
    const info = db.db
      .prepare("PRAGMA table_info(cost_records)")
      .all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("cache_read_input_tokens");
  });

  it("adds audit_event_id column to cost_records", () => {
    const info = db.db
      .prepare("PRAGMA table_info(cost_records)")
      .all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("audit_event_id");
  });

  it("adds transcript_offset column to sessions", () => {
    const info = db.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("transcript_offset");
  });

  it("transcript_offset defaults to 0", () => {
    db.insert("sessions", {
      id: "test-migration-v6",
      objective: "migration test",
      state: "created",
      started_at: new Date().toISOString(),
    });

    const row = db.fetchOne(
      "SELECT transcript_offset FROM sessions WHERE id = ?",
      ["test-migration-v6"],
    );
    expect(row!.transcript_offset).toBe(0);
  });

  it("schema version is at least 6", () => {
    expect(db.schemaVersion).toBeGreaterThanOrEqual(6);
  });
});
