import path from "node:path";
import type { Db } from "../store/db.js";
import { AuditLogger } from "./audit.js";
import { displayEventType } from "./event-types.js";
import { loadSigningKey, verifyChain } from "./signing.js";
import { StateManager } from "./state.js";
import type { AuditEvent } from "../models/audit.js";

export interface CheckpointResult {
  timestamp: string;
  sessionId: string;
  chainIntegrity: { valid: boolean; eventsChecked: number; errors: number };
  violations: { total: number; reverted: number; unresolved: number };
  gateEvents: { total: number; eventTypes: string[] };
  agentCount: number;
  eventCount: number;
  attestation: string;
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const deltaMs = Math.max(0, end - start);
  const totalSeconds = Math.floor(deltaMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export function generateCheckpoint(
  db: Db,
  sessionId: string,
  projectRoot: string,
): CheckpointResult {
  const sm = new StateManager(db, projectRoot);
  const session = sm.getSession(sessionId);
  if (!session) {
    throw new Error("session not found");
  }

  const logger = new AuditLogger(db, sessionId);
  const eventsDesc = logger.getEvents({ limit: 100000 });
  const events = [...eventsDesc].reverse();
  const eventCount = events.length;

  const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
  const verification = signingKey
    ? verifyChain(signingKey, sessionId, events as AuditEvent[])
    : { valid: false, eventsChecked: eventCount, errors: [{ sequence: 0, type: "missing", message: "no signing key" }] };
  const chainIntegrity = {
    valid: verification.valid,
    eventsChecked: verification.eventsChecked,
    errors: verification.errors.length,
  };

  const violationRow = db.fetchOne(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN enforcement_action = 'reverted' THEN 1 ELSE 0 END) as reverted
     FROM boundary_violations
     WHERE session_id = ?`,
    [sessionId],
  );
  const violationsTotal = Number(violationRow?.total ?? 0);
  const violationsReverted = Number(violationRow?.reverted ?? 0);
  const violations = {
    total: violationsTotal,
    reverted: violationsReverted,
    unresolved: Math.max(0, violationsTotal - violationsReverted),
  };

  const gateRows = db.fetchAll(
    `SELECT event_type FROM audit_events
     WHERE session_id = ? AND event_type = 'gate_triggered'`,
    [sessionId],
  );
  const gateTypes = new Set<string>();
  for (const row of gateRows) {
    gateTypes.add(displayEventType(String(row.event_type)));
  }
  const gateEvents = {
    total: gateRows.length,
    eventTypes: [...gateTypes].sort((a, b) => a.localeCompare(b)),
  };

  const agentRow = db.fetchOne(
    "SELECT COUNT(*) as count FROM agents WHERE session_id = ?",
    [sessionId],
  );
  const agentCount = Number(agentRow?.count ?? 0);
  const timestamp = new Date().toISOString();

  const attestation = [
    "# Khoregos compliance checkpoint",
    "",
    `**Generated:** ${timestamp}`,
    `**Session:** ${sessionId}`,
    "",
    "## Audit chain integrity",
    "",
    `Status: ${chainIntegrity.valid ? "valid" : "invalid"}.`,
    `Events checked: ${chainIntegrity.eventsChecked}.`,
    `Errors: ${chainIntegrity.errors === 0 ? "none" : String(chainIntegrity.errors)}.`,
    "",
    "## Boundary compliance",
    "",
    `Total violations: ${violations.total}.`,
    `Reverted (strict enforcement): ${violations.reverted}.`,
    `Logged only or unresolved: ${violations.unresolved}.`,
    "",
    "## Sensitive file annotations",
    "",
    `Total gate events: ${gateEvents.total}.`,
    `Event types observed: ${gateEvents.eventTypes.length ? gateEvents.eventTypes.join(", ") : "none"}.`,
    "",
    "## Session summary",
    "",
    `Agents: ${agentCount}.`,
    `Total events: ${eventCount}.`,
    `Duration: ${formatDuration(session.startedAt, session.endedAt)}.`,
    "",
    "## Attestation",
    "",
    `This checkpoint attests that at ${timestamp}, the Khoregos governance`,
    `trail for session ${sessionId} was inspected and found to have a`,
    `${chainIntegrity.valid ? "valid" : "invalid"} HMAC chain with ${chainIntegrity.eventsChecked} verified events.`,
    "",
  ].join("\n");

  return {
    timestamp,
    sessionId,
    chainIntegrity,
    violations,
    gateEvents,
    agentCount,
    eventCount,
    attestation,
  };
}
