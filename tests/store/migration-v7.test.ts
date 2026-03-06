/**
 * Tests for migration v7: transcript_entries table.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("migration v7", () => {
  let db: Db;

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("creates transcript_entries table", () => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_entries'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("has all required columns", () => {
    const info = db.db
      .prepare("PRAGMA table_info(transcript_entries)")
      .all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("agent_id");
    expect(colNames).toContain("sequence");
    expect(colNames).toContain("entry_type");
    expect(colNames).toContain("role");
    expect(colNames).toContain("model");
    expect(colNames).toContain("content");
    expect(colNames).toContain("input_tokens");
    expect(colNames).toContain("output_tokens");
    expect(colNames).toContain("cache_creation_input_tokens");
    expect(colNames).toContain("cache_read_input_tokens");
    expect(colNames).toContain("timestamp");
    expect(colNames).toContain("redacted");
  });

  it("creates session index on transcript_entries", () => {
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_transcript_session'")
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("creates type index on transcript_entries", () => {
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_transcript_type'")
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("schema version is 7", () => {
    expect(db.schemaVersion).toBe(7);
  });
});
