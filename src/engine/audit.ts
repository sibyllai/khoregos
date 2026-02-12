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
  type EventType,
  auditEventFromDbRow,
  auditEventToDbRow,
} from "../models/audit.js";

export class AuditLogger {
  private sequence = 0;

  constructor(
    private db: Db,
    private sessionId: string,
  ) {}

  start(): void {
    const row = this.db.fetchOne(
      "SELECT MAX(sequence) as max_seq FROM audit_events WHERE session_id = ?",
      [this.sessionId],
    );
    this.sequence = (row?.max_seq as number) ?? 0;
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
      details: opts.details ? JSON.stringify(opts.details) : null,
      filesAffected: opts.filesAffected?.length
        ? JSON.stringify(opts.filesAffected)
        : null,
      gateId: opts.gateId ?? null,
      hmac: null,
    };

    this.db.insert("audit_events", auditEventToDbRow(event));
    return event;
  }

  getEvents(opts?: {
    limit?: number;
    offset?: number;
    eventType?: EventType;
    agentId?: string;
    since?: string;
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
