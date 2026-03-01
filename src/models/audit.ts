/**
 * Audit event model for tracking all significant actions.
 */

import { z } from "zod";
import { ulid } from "ulid";
import type { Row } from "../store/db.js";

export const EventType = z.enum([
  // File operations
  "file_create",
  "file_modify",
  "file_delete",
  // Session lifecycle
  "session_start",
  "session_pause",
  "session_resume",
  "session_complete",
  "session_fail",
  // Agent lifecycle
  "agent_spawn",
  "agent_complete",
  "agent_fail",
  // Task tracking
  "task_create",
  "task_update",
  "task_complete",
  // Sensitive-file audit annotation (displayed as sensitive_needs_review).
  "gate_triggered",
  // Boundary events
  "boundary_violation",
  "boundary_check",
  // Lock events
  "lock_acquired",
  "lock_released",
  "lock_denied",
  // Context events
  "context_saved",
  "context_loaded",
  // Tool use (captured via Claude Code hooks)
  "tool_use",
  // Dependency tracking (supply chain visibility).
  "dependency_added",
  "dependency_removed",
  "dependency_updated",
  // Generic
  "log",
  "system",
]);
export type EventType = z.infer<typeof EventType>;

export const AuditSeverity = z.enum(["info", "warning", "critical"]);
export type AuditSeverity = z.infer<typeof AuditSeverity>;

export const AuditEventSchema = z.object({
  id: z.string().default(() => ulid()),
  timestamp: z.string().default(() => new Date().toISOString()),
  sequence: z.number().default(0),
  sessionId: z.string(),
  agentId: z.string().nullable().default(null),
  eventType: EventType,
  action: z.string(),
  details: z.string().nullable().default(null),
  filesAffected: z.string().nullable().default(null),
  gateId: z.string().nullable().default(null),
  hmac: z.string().nullable().default(null),
  severity: AuditSeverity.default("info"),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function auditEventToDbRow(e: AuditEvent): Row {
  return {
    id: e.id,
    sequence: e.sequence,
    session_id: e.sessionId,
    agent_id: e.agentId,
    timestamp: e.timestamp,
    event_type: e.eventType,
    action: e.action,
    details: e.details,
    files_affected: e.filesAffected,
    gate_id: e.gateId,
    hmac: e.hmac,
    severity: e.severity,
  };
}

export function auditEventFromDbRow(row: Row): AuditEvent {
  return {
    id: row.id as string,
    sequence: row.sequence as number,
    sessionId: row.session_id as string,
    agentId: (row.agent_id as string) ?? null,
    timestamp: row.timestamp as string,
    eventType: row.event_type as EventType,
    action: row.action as string,
    details: (row.details as string) ?? null,
    filesAffected: (row.files_affected as string) ?? null,
    gateId: (row.gate_id as string) ?? null,
    hmac: (row.hmac as string) ?? null,
    severity: (row.severity as AuditSeverity) ?? "info",
  };
}

export function shortSummary(e: AuditEvent): string {
  const agent = e.agentId ? `[${e.agentId}]` : "[system]";
  const time = new Date(e.timestamp).toTimeString().slice(0, 8);
  return `${time} ${agent} ${e.eventType}: ${e.action}`;
}
