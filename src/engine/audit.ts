/**
 * Audit logger for recording all significant actions.
 *
 * Simplified from Python: no buffer, no flush loop, no async lock.
 * better-sqlite3 is synchronous — writes succeed or throw immediately.
 */

import { ulid } from "ulid";
import type { Db } from "../store/db.js";
import {
  type AuditEvent,
  type AuditSeverity,
  type EventType,
  auditEventFromDbRow,
  auditEventToDbRow,
} from "../models/audit.js";
import { computeHmac, genesisValue } from "./signing.js";
import { recordAuditEvent } from "./telemetry.js";

export class AuditLogger {
  private sequence = 0;
  private lastHmac: string | null = null;

  constructor(
    private db: Db,
    private sessionId: string,
    private traceId?: string | null,
    private signingKey?: Buffer | null,
  ) {}

  start(): void {
    const row = this.db.fetchOne(
      "SELECT MAX(sequence) as max_seq FROM audit_events WHERE session_id = ?",
      [this.sessionId],
    );
    this.sequence = (row?.max_seq as number) ?? 0;

    // Load the last HMAC in the chain for continuity.
    if (this.signingKey && this.sequence > 0) {
      const lastRow = this.db.fetchOne(
        "SELECT hmac FROM audit_events WHERE session_id = ? AND sequence = ?",
        [this.sessionId, this.sequence],
      );
      this.lastHmac = (lastRow?.hmac as string) ?? null;
    }
  }

  stop(): void {
    // no-op — nothing to flush with sync writes
  }

  log(opts: {
    eventType: EventType;
    action: string;
    agentId?: string | null;
    details?: Record<string, unknown>;
    filesAffected?: string[];
    gateId?: string | null;
    severity?: AuditSeverity;
  }): AuditEvent {
    this.sequence += 1;

    const event: AuditEvent = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      sequence: this.sequence,
      sessionId: this.sessionId,
      agentId: opts.agentId ?? null,
      eventType: opts.eventType,
      action: opts.action,
      details: opts.details || this.traceId
        ? JSON.stringify({
            ...(opts.details ?? {}),
            ...(this.traceId ? { trace_id: this.traceId } : {}),
          })
        : null,
      filesAffected: opts.filesAffected?.length
        ? JSON.stringify(opts.filesAffected)
        : null,
      gateId: opts.gateId ?? null,
      hmac: null,
      severity: opts.severity ?? "info",
    };

    // Compute HMAC chain if a signing key is available.
    if (this.signingKey) {
      const previousHmac = this.lastHmac ?? genesisValue(this.sessionId);
      event.hmac = computeHmac(this.signingKey, previousHmac, event);
      this.lastHmac = event.hmac;
    }

    this.db.insert("audit_events", auditEventToDbRow(event));
    recordAuditEvent(event.eventType, event.severity);
    return event;
  }

  getEvents(opts?: {
    limit?: number;
    offset?: number;
    eventType?: EventType;
    agentId?: string;
    since?: string;
    severity?: AuditSeverity;
    traceId?: string;
  }): AuditEvent[] {
    const conditions: string[] = ["session_id = ?"];
    const params: unknown[] = [this.sessionId];

    if (opts?.eventType) {
      conditions.push("event_type = ?");
      params.push(opts.eventType);
    }
    if (opts?.agentId) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts?.since) {
      conditions.push("timestamp > ?");
      params.push(opts.since);
    }
    if (opts?.severity) {
      conditions.push("severity = ?");
      params.push(opts.severity);
    }
    if (opts?.traceId) {
      conditions.push("json_extract(details, '$.trace_id') = ?");
      params.push(opts.traceId);
    }

    const where = conditions.join(" AND ");
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const sql = `SELECT * FROM audit_events WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.fetchAll(sql, params).map(auditEventFromDbRow);
  }

  getEventCount(): number {
    const row = this.db.fetchOne(
      "SELECT COUNT(*) as count FROM audit_events WHERE session_id = ?",
      [this.sessionId],
    );
    return (row?.count as number) ?? 0;
  }
}

/**
 * Prune old audit data across all sessions. Deletes audit events,
 * and cascades to orphaned related records for completed sessions
 * whose events have all been pruned.
 *
 * @returns The number of audit events deleted.
 */
export function pruneAuditEvents(
  db: Db,
  beforeDate: string,
  dryRun = false,
): { eventsDeleted: number; sessionsPruned: number } {
  if (dryRun) {
    const eventCount = db.fetchOne(
      "SELECT COUNT(*) as count FROM audit_events WHERE timestamp < ?",
      [beforeDate],
    );
    // Sessions that ended before the cutoff with no remaining events.
    const sessionCount = db.fetchOne(
      `SELECT COUNT(*) as count FROM sessions
       WHERE state IN ('completed', 'failed')
       AND ended_at IS NOT NULL AND ended_at < ?`,
      [beforeDate],
    );
    return {
      eventsDeleted: (eventCount?.count as number) ?? 0,
      sessionsPruned: (sessionCount?.count as number) ?? 0,
    };
  }

  // Delete old events.
  const eventResult = db.db
    .prepare("DELETE FROM audit_events WHERE timestamp < ?")
    .run(beforeDate);

  // Find completed/failed sessions that ended before the cutoff.
  const staleSessions = db.fetchAll(
    `SELECT id FROM sessions
     WHERE state IN ('completed', 'failed')
     AND ended_at IS NOT NULL AND ended_at < ?`,
    [beforeDate],
  );

  let sessionsPruned = 0;
  for (const row of staleSessions) {
    const sid = row.id as string;
    // Only prune if no audit events remain for this session.
    const remaining = db.fetchOne(
      "SELECT COUNT(*) as count FROM audit_events WHERE session_id = ?",
      [sid],
    );
    if (((remaining?.count as number) ?? 0) === 0) {
      // Cascade-delete related records.
      for (const table of [
        "boundary_violations",
        "file_locks",
        "context_store",
        "gates",
        "cost_records",
        "agents",
      ]) {
        db.delete(table, "session_id = ?", [sid]);
      }
      db.delete("sessions", "id = ?", [sid]);
      sessionsPruned++;
    }
  }

  return { eventsDeleted: eventResult.changes, sessionsPruned };
}
