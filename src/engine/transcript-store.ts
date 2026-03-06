/**
 * Transcript storage: ingest JSONL entries into SQLite.
 *
 * Reads new transcript lines incrementally, applies redaction and
 * thinking-block stripping, then stores in the transcript_entries table.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { ulid } from "ulid";
import type { Db } from "../store/db.js";
import type { TranscriptConfig } from "../models/config.js";
import { readTranscriptIncremental } from "./transcript.js";
import { redactFull, stripThinkingBlocks } from "./redaction.js";

export interface StoredTranscriptEntry {
  id: string;
  sessionId: string;
  agentId: string | null;
  sequence: number;
  entryType: string;
  role: string | null;
  model: string | null;
  content: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  timestamp: string;
  redacted: boolean;
}

/**
 * Parse a raw JSONL line into content suitable for storage.
 */
function extractContent(
  raw: Record<string, unknown>,
  config: TranscriptConfig,
): { content: string | null; role: string | null; redacted: boolean } {
  const msg = raw.message as Record<string, unknown> | undefined;
  if (!msg) return { content: null, role: null, redacted: false };

  const role = (msg.role as string) ?? null;

  // For usage-only mode, skip content entirely.
  if (config.store === "usage-only") {
    return { content: null, role, redacted: false };
  }

  let content: string;
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          parts.push(`<thinking>${b.thinking}</thinking>`);
        } else if (b.type === "tool_use") {
          parts.push(`[tool_use: ${b.name ?? "unknown"}]`);
        } else if (b.type === "tool_result") {
          const resultContent = typeof b.content === "string"
            ? b.content.slice(0, 500)
            : "[tool_result]";
          parts.push(resultContent);
        }
      }
    }
    content = parts.join("\n");
  } else {
    content = JSON.stringify(msg.content ?? "");
  }

  // Strip thinking blocks if configured.
  if (config.strip_thinking) {
    content = stripThinkingBlocks(content);
  }

  // Truncate to max length.
  if (content.length > config.max_content_length) {
    content = content.slice(0, config.max_content_length) + "...[truncated]";
  }

  // Apply redaction: regex patterns + NER.
  const result = redactFull(content, config.redaction_patterns, {
    ner: config.ner_redaction,
  });

  return { content: result.text, role, redacted: result.redacted };
}

/**
 * Get the next sequence number for transcript entries in a session.
 */
function nextSequence(db: Db, sessionId: string): number {
  const row = db.fetchOne(
    "SELECT MAX(sequence) AS max_seq FROM transcript_entries WHERE session_id = ?",
    [sessionId],
  );
  return ((row?.max_seq as number) ?? 0) + 1;
}

/**
 * Re-read raw JSONL lines between two byte offsets for content extraction.
 */
function readRawLines(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Record<string, unknown>[] {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return [];
  }

  try {
    const len = endOffset - startOffset;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, startOffset);
    const raw = buf.toString("utf-8");
    const lines = raw.split("\n");
    const results: Record<string, unknown>[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // Skip malformed lines.
      }
    }
    return results;
  } finally {
    closeSync(fd);
  }
}

/**
 * Ingest new transcript entries from a JSONL file into the database.
 * Only processes lines after the stored byte offset.
 *
 * Returns the number of entries stored.
 */
export function ingestTranscript(opts: {
  db: Db;
  sessionId: string;
  agentId: string | null;
  transcriptPath: string;
  byteOffset: number;
  config: TranscriptConfig;
}): { stored: number; newOffset: number } {
  if (opts.config.store === "off") {
    return { stored: 0, newOffset: opts.byteOffset };
  }

  const { entries, newOffset } = readTranscriptIncremental(
    opts.transcriptPath,
    opts.byteOffset,
  );

  if (entries.length === 0) {
    return { stored: 0, newOffset };
  }

  // Re-read raw lines for content extraction (the transcript reader
  // only extracts usage metadata, not full message content).
  const rawEntries = readRawLines(opts.transcriptPath, opts.byteOffset, newOffset);

  let seq = nextSequence(opts.db, opts.sessionId);
  let stored = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const raw = rawEntries[i] ?? {};

    // Skip non-conversation entries (e.g. file-history-snapshot).
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const { content, role, redacted } = extractContent(raw, opts.config);

    opts.db.insert("transcript_entries", {
      id: ulid(),
      session_id: opts.sessionId,
      agent_id: opts.agentId,
      sequence: seq++,
      entry_type: entry.type,
      role: role ?? (entry.type === "user" ? "user" : "assistant"),
      model: entry.model ?? null,
      content,
      input_tokens: entry.usage?.inputTokens ?? null,
      output_tokens: entry.usage?.outputTokens ?? null,
      cache_creation_input_tokens: entry.usage?.cacheCreationInputTokens ?? null,
      cache_read_input_tokens: entry.usage?.cacheReadInputTokens ?? null,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      redacted: redacted ? 1 : 0,
    });
    stored++;
  }

  return { stored, newOffset };
}

/**
 * Query stored transcript entries for a session.
 */
export function queryTranscript(
  db: Db,
  sessionId: string,
  opts?: {
    limit?: number;
    offset?: number;
    role?: string;
    entryType?: string;
  },
): StoredTranscriptEntry[] {
  const conditions = ["session_id = ?"];
  const params: unknown[] = [sessionId];

  if (opts?.role) {
    conditions.push("role = ?");
    params.push(opts.role);
  }
  if (opts?.entryType) {
    conditions.push("entry_type = ?");
    params.push(opts.entryType);
  }

  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  const where = conditions.join(" AND ");
  const sql = `SELECT * FROM transcript_entries WHERE ${where} ORDER BY sequence ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.fetchAll(sql, params).map(rowToEntry);
}

/**
 * Count transcript entries for a session.
 */
export function countTranscriptEntries(
  db: Db,
  sessionId: string,
): number {
  const row = db.fetchOne(
    "SELECT COUNT(*) AS cnt FROM transcript_entries WHERE session_id = ?",
    [sessionId],
  );
  return (row?.cnt as number) ?? 0;
}

function rowToEntry(row: Record<string, unknown>): StoredTranscriptEntry {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    agentId: (row.agent_id as string) ?? null,
    sequence: row.sequence as number,
    entryType: row.entry_type as string,
    role: (row.role as string) ?? null,
    model: (row.model as string) ?? null,
    content: (row.content as string) ?? null,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    cacheCreationInputTokens: (row.cache_creation_input_tokens as number) ?? null,
    cacheReadInputTokens: (row.cache_read_input_tokens as number) ?? null,
    timestamp: row.timestamp as string,
    redacted: Boolean(row.redacted),
  };
}
