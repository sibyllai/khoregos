/**
 * Tests for transcript storage (ingestion, query, redaction).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import {
  ingestTranscript,
  queryTranscript,
  countTranscriptEntries,
} from "../../src/engine/transcript-store.js";
import type { TranscriptConfig } from "../../src/models/config.js";
import { TranscriptConfigSchema } from "../../src/models/config.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

let db: Db;
let state: StateManager;
let sessionId: string;
let agentId: string;
let tempDir: string;

function writeTranscript(
  lines: Record<string, unknown>[],
  name = "transcript.jsonl",
): string {
  const fp = path.join(tempDir, name);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(fp, content);
  return fp;
}

function fullConfig(overrides?: Partial<TranscriptConfig>): TranscriptConfig {
  return TranscriptConfigSchema.parse({ store: "full", ...overrides });
}

function usageOnlyConfig(): TranscriptConfig {
  return TranscriptConfigSchema.parse({ store: "usage-only" });
}

function offConfig(): TranscriptConfig {
  return TranscriptConfigSchema.parse({ store: "off" });
}

beforeAll(() => {
  db = new Db(getTempDbPath());
  db.connect();
  state = new StateManager(db, "/tmp/k6s-transcript-store-test");

  const session = state.createSession({ objective: "transcript store test" });
  sessionId = session.id;

  const agent = state.registerAgent({ sessionId, name: "primary" });
  agentId = agent.id;

  tempDir = mkdtempSync(path.join(tmpdir(), "k6s-ts-test-"));
});

afterAll(() => {
  db.close();
  cleanupTempDir();
  try {
    const { rmSync } = require("node:fs");
    rmSync(tempDir, { recursive: true });
  } catch {
    // ignore
  }
});

describe("ingestTranscript", () => {
  it("returns 0 when store is 'off'", () => {
    const fp = writeTranscript([
      { type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
    ], "off.jsonl");

    const result = ingestTranscript({
      db,
      sessionId,
      agentId,
      transcriptPath: fp,
      byteOffset: 0,
      config: offConfig(),
    });
    expect(result.stored).toBe(0);
  });

  it("stores user and assistant entries in full mode", () => {
    const fp = writeTranscript([
      { type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ], "full.jsonl");

    const result = ingestTranscript({
      db,
      sessionId,
      agentId,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig(),
    });
    expect(result.stored).toBe(2);
    expect(result.newOffset).toBeGreaterThan(0);
  });

  it("skips non-conversation entries (file-history-snapshot)", () => {
    const fp = writeTranscript([
      { type: "file-history-snapshot", uuid: "f1", files: {} },
      { type: "user", uuid: "u2", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "test" } },
    ], "skip.jsonl");

    const result = ingestTranscript({
      db,
      sessionId,
      agentId,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig(),
    });
    expect(result.stored).toBe(1);
  });

  it("stores null content in usage-only mode", () => {
    // Use a new session to avoid mixing with previous test data.
    const sess2 = state.createSession({ objective: "usage-only test" });
    const agent2 = state.registerAgent({ sessionId: sess2.id, name: "primary" });

    const fp = writeTranscript([
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-01-01T00:00:03Z",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: "secret content" }],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      },
    ], "usage-only.jsonl");

    ingestTranscript({
      db,
      sessionId: sess2.id,
      agentId: agent2.id,
      transcriptPath: fp,
      byteOffset: 0,
      config: usageOnlyConfig(),
    });

    const entries = queryTranscript(db, sess2.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBeNull();
    expect(entries[0].inputTokens).toBe(200);
    expect(entries[0].outputTokens).toBe(100);
  });

  it("applies PII redaction to content (regex + NER)", () => {
    const sess3 = state.createSession({ objective: "redaction test" });
    const agent3 = state.registerAgent({ sessionId: sess3.id, name: "primary" });

    const fp = writeTranscript([
      {
        type: "user",
        uuid: "u3",
        timestamp: "2026-01-01T00:00:04Z",
        message: { role: "user", content: "Please email John Doe at test@example.com today" },
      },
    ], "redact.jsonl");

    ingestTranscript({
      db,
      sessionId: sess3.id,
      agentId: agent3.id,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig(),
    });

    const entries = queryTranscript(db, sess3.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("[EMAIL]");
    expect(entries[0].content).not.toContain("test@example.com");
    expect(entries[0].content).not.toContain("John Doe");
    expect(entries[0].redacted).toBe(true);
  });

  it("skips NER when ner_redaction is false", () => {
    const sess3b = state.createSession({ objective: "no ner test" });
    const agent3b = state.registerAgent({ sessionId: sess3b.id, name: "primary" });

    const fp = writeTranscript([
      {
        type: "user",
        uuid: "u3b",
        timestamp: "2026-01-01T00:00:04Z",
        message: { role: "user", content: "Please email John Doe at test@example.com today" },
      },
    ], "no-ner.jsonl");

    ingestTranscript({
      db,
      sessionId: sess3b.id,
      agentId: agent3b.id,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig({ ner_redaction: false }),
    });

    const entries = queryTranscript(db, sess3b.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("[EMAIL]");
    // NER disabled — name should remain.
    expect(entries[0].content).toContain("John Doe");
  });

  it("strips thinking blocks when configured", () => {
    const sess4 = state.createSession({ objective: "thinking strip test" });
    const agent4 = state.registerAgent({ sessionId: sess4.id, name: "primary" });

    const fp = writeTranscript([
      {
        type: "assistant",
        uuid: "a4",
        timestamp: "2026-01-01T00:00:05Z",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "visible response" },
          ],
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    ], "thinking.jsonl");

    ingestTranscript({
      db,
      sessionId: sess4.id,
      agentId: agent4.id,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig({ strip_thinking: true }),
    });

    const entries = queryTranscript(db, sess4.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("visible response");
    expect(entries[0].content).not.toContain("internal reasoning");
    expect(entries[0].content).toContain("[thinking block removed]");
  });

  it("truncates content exceeding max length", () => {
    const sess5 = state.createSession({ objective: "truncation test" });
    const agent5 = state.registerAgent({ sessionId: sess5.id, name: "primary" });

    const longContent = "x".repeat(200);
    const fp = writeTranscript([
      {
        type: "user",
        uuid: "u5",
        timestamp: "2026-01-01T00:00:06Z",
        message: { role: "user", content: longContent },
      },
    ], "truncate.jsonl");

    ingestTranscript({
      db,
      sessionId: sess5.id,
      agentId: agent5.id,
      transcriptPath: fp,
      byteOffset: 0,
      config: fullConfig({ max_content_length: 100 }),
    });

    const entries = queryTranscript(db, sess5.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].content!.length).toBeLessThan(200);
    expect(entries[0].content).toContain("...[truncated]");
  });
});

describe("queryTranscript", () => {
  it("filters by role", () => {
    // Uses entries from the 'full.jsonl' test above.
    const userEntries = queryTranscript(db, sessionId, { role: "user" });
    for (const e of userEntries) {
      expect(e.role).toBe("user");
    }
  });

  it("supports limit and offset", () => {
    const first = queryTranscript(db, sessionId, { limit: 1, offset: 0 });
    const second = queryTranscript(db, sessionId, { limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    if (second.length > 0) {
      expect(second[0].sequence).toBeGreaterThan(first[0].sequence);
    }
  });
});

describe("countTranscriptEntries", () => {
  it("returns correct count for a session", () => {
    const count = countTranscriptEntries(db, sessionId);
    // We stored 2 in the full mode test + 1 in skip test = 3
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("returns 0 for unknown session", () => {
    expect(countTranscriptEntries(db, "nonexistent")).toBe(0);
  });
});
