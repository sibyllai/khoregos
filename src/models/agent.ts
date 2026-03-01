/**
 * Agent model for tracking individual agents within a session.
 */

import { z } from "zod";
import { ulid } from "ulid";
import type { Row } from "../store/db.js";

export const AgentRole = z.enum(["lead", "teammate"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentState = z.enum(["active", "idle", "completed", "failed"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentSchema = z.object({
  id: z.string().default(() => ulid()),
  sessionId: z.string(),
  name: z.string(),
  role: AgentRole.default("teammate"),
  specialization: z.string().nullable().default(null),
  state: AgentState.default("active"),
  spawnedAt: z.string().default(() => new Date().toISOString()),
  boundaryConfig: z.string().nullable().default(null),
  metadata: z.string().nullable().default(null),
  claudeSessionId: z.string().nullable().default(null),
  toolCallCount: z.number().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

export function agentToDbRow(a: Agent): Row {
  const row: Row = {
    id: a.id,
    session_id: a.sessionId,
    name: a.name,
    role: a.role,
    specialization: a.specialization,
    state: a.state,
    spawned_at: a.spawnedAt,
    boundary_config: a.boundaryConfig,
    metadata: a.metadata,
    tool_call_count: a.toolCallCount,
  };
  if (a.claudeSessionId != null) row.claude_session_id = a.claudeSessionId;
  return row;
}

export function agentFromDbRow(row: Row): Agent {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    name: row.name as string,
    role: (row.role as AgentRole) ?? "teammate",
    specialization: (row.specialization as string) ?? null,
    state: (row.state as AgentState) ?? "active",
    spawnedAt: row.spawned_at as string,
    boundaryConfig: (row.boundary_config as string) ?? null,
    metadata: (row.metadata as string) ?? null,
    claudeSessionId: (row.claude_session_id as string) ?? null,
    toolCallCount: (row.tool_call_count as number) ?? 0,
  };
}

export function isAgentActive(a: Agent): boolean {
  return a.state === "active" || a.state === "idle";
}
