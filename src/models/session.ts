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
  totalCostUsd: z.number().default(0),
  totalInputTokens: z.number().default(0),
  totalOutputTokens: z.number().default(0),
  metadata: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;

export function sessionToDbRow(s: Session): Row {
  return {
    id: s.id,
    objective: s.objective,
    state: s.state,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    parent_session_id: s.parentSessionId,
    config_snapshot: s.configSnapshot,
    context_summary: s.contextSummary,
    total_cost_usd: s.totalCostUsd,
    total_input_tokens: s.totalInputTokens,
    total_output_tokens: s.totalOutputTokens,
    metadata: s.metadata,
  };
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
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    totalInputTokens: (row.total_input_tokens as number) ?? 0,
    totalOutputTokens: (row.total_output_tokens as number) ?? 0,
    metadata: (row.metadata as string) ?? null,
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
