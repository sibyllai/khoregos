/**
 * Session model for tracking agent team sessions.
 */

import { z } from "zod";
import { ulid } from "ulid";
import type { Row } from "../store/db.js";

export const SessionState = z.enum([
  "created",
  "active",
  "paused",
  "completed",
  "failed",
]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionSchema = z.object({
  id: z.string().default(() => ulid()),
  objective: z.string(),
  state: SessionState.default("created"),
  startedAt: z.string().default(() => new Date().toISOString()),
  endedAt: z.string().nullable().default(null),
  parentSessionId: z.string().nullable().default(null),
  configSnapshot: z.string().nullable().default(null),
  contextSummary: z.string().nullable().default(null),
  metadata: z.string().nullable().default(null),
  operator: z.string().nullable().default(null),
  hostname: z.string().nullable().default(null),
  k6sVersion: z.string().nullable().default(null),
  claudeCodeVersion: z.string().nullable().default(null),
  gitBranch: z.string().nullable().default(null),
  gitSha: z.string().nullable().default(null),
  gitDirty: z.boolean().default(false),
  traceId: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;

export function sessionToDbRow(s: Session): Row {
  const row: Row = {
    id: s.id,
    objective: s.objective,
    state: s.state,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    parent_session_id: s.parentSessionId,
    config_snapshot: s.configSnapshot,
    context_summary: s.contextSummary,
    metadata: s.metadata,
  };
  if (s.operator != null) row.operator = s.operator;
  if (s.hostname != null) row.hostname = s.hostname;
  if (s.k6sVersion != null) row.k6s_version = s.k6sVersion;
  if (s.claudeCodeVersion != null) row.claude_code_version = s.claudeCodeVersion;
  if (s.gitBranch != null) row.git_branch = s.gitBranch;
  if (s.gitSha != null) row.git_sha = s.gitSha;
  row.git_dirty = s.gitDirty ? 1 : 0;
  if (s.traceId != null) row.trace_id = s.traceId;
  return row;
}

export function sessionFromDbRow(row: Row): Session {
  return {
    id: row.id as string,
    objective: row.objective as string,
    state: row.state as SessionState,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    configSnapshot: (row.config_snapshot as string) ?? null,
    contextSummary: (row.context_summary as string) ?? null,
    metadata: (row.metadata as string) ?? null,
    operator: (row.operator as string) ?? null,
    hostname: (row.hostname as string) ?? null,
    k6sVersion: (row.k6s_version as string) ?? null,
    claudeCodeVersion: (row.claude_code_version as string) ?? null,
    gitBranch: (row.git_branch as string) ?? null,
    gitSha: (row.git_sha as string) ?? null,
    gitDirty: (row.git_dirty as number) === 1,
    traceId: (row.trace_id as string) ?? null,
  };
}

export function isSessionActive(s: Session): boolean {
  return s.state === "created" || s.state === "active";
}

export function sessionDurationSeconds(s: Session): number | null {
  if (!s.endedAt) return null;
  return (
    (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000
  );
}
