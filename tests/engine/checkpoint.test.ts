/**
 * Tests for compliance checkpoint generation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { sessionToDbRow, type Session } from "../../src/models/session.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { generateCheckpoint } from "../../src/engine/checkpoint.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function createFixture(): { projectRoot: string; db: Db; sessionId: string; traceId: string } {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-checkpoint-test-"));
  cleanupPaths.push(projectRoot);
  const khoregosDir = path.join(projectRoot, ".khoregos");
  mkdirSync(khoregosDir, { recursive: true });
  const db = new Db(path.join(khoregosDir, "k6s.db"));
  db.connect();
  const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
  const traceId = "trace-checkpoint";
  const session: Session = {
    id: sessionId,
    objective: "checkpoint test",
    state: "completed",
    startedAt: "2026-02-20T12:00:00.000Z",
    endedAt: "2026-02-20T12:05:00.000Z",
    parentSessionId: null,
    configSnapshot: null,
    contextSummary: null,
    metadata: null,
    operator: null,
    hostname: null,
    k6sVersion: null,
    claudeCodeVersion: null,
    gitBranch: null,
    gitSha: null,
    gitDirty: false,
    traceId,
  };
  db.insert("sessions", sessionToDbRow(session));
  return { projectRoot, db, sessionId, traceId };
}

describe("generateCheckpoint", () => {
  it("builds checkpoint with valid chain and expected summary fields", () => {
    const { projectRoot, db, sessionId, traceId } = createFixture();
    try {
      generateSigningKey(path.join(projectRoot, ".khoregos"));
      const key = loadSigningKey(path.join(projectRoot, ".khoregos"));
      expect(key).not.toBeNull();
      const logger = new AuditLogger(db, sessionId, traceId, key);
      logger.start();
      logger.log({ eventType: "session_start", action: "start" });
      logger.log({ eventType: "tool_use", action: "tool use", severity: "warning" });
      logger.log({ eventType: "gate_triggered", action: "gate", severity: "warning" });
      logger.stop();
      db.insert("agents", {
        id: "agent-1",
        session_id: sessionId,
        name: "primary",
        role: "lead",
        state: "completed",
        spawned_at: "2026-02-20T12:00:00.000Z",
      });

      const result = generateCheckpoint(db, sessionId, projectRoot);
      expect(result.chainIntegrity.valid).toBe(true);
      expect(result.chainIntegrity.eventsChecked).toBe(3);
      expect(result.gateEvents.total).toBe(1);
      expect(result.gateEvents.eventTypes).toContain("sensitive_needs_review");
      expect(result.agentCount).toBe(1);
      expect(result.attestation).toContain("Status: valid.");
      expect(result.attestation).toContain("Total gate events: 1.");
    } finally {
      db.close();
    }
  });

  it("counts boundary violations and unresolved totals", () => {
    const { projectRoot, db, sessionId } = createFixture();
    try {
      generateSigningKey(path.join(projectRoot, ".khoregos"));
      db.insert("boundary_violations", {
        id: "vio-1",
        session_id: sessionId,
        agent_id: null,
        timestamp: "2026-02-20T12:01:00.000Z",
        file_path: "a.txt",
        violation_type: "forbidden_path",
        enforcement_action: "reverted",
        details: null,
      });
      db.insert("boundary_violations", {
        id: "vio-2",
        session_id: sessionId,
        agent_id: null,
        timestamp: "2026-02-20T12:02:00.000Z",
        file_path: "b.txt",
        violation_type: "forbidden_path",
        enforcement_action: "logged",
        details: null,
      });

      const result = generateCheckpoint(db, sessionId, projectRoot);
      expect(result.violations.total).toBe(2);
      expect(result.violations.reverted).toBe(1);
      expect(result.violations.unresolved).toBe(1);
      expect(result.attestation).toContain("Total violations: 2.");
    } finally {
      db.close();
    }
  });

  it("handles sessions with no events gracefully", () => {
    const { projectRoot, db, sessionId } = createFixture();
    try {
      generateSigningKey(path.join(projectRoot, ".khoregos"));
      const result = generateCheckpoint(db, sessionId, projectRoot);
      expect(result.eventCount).toBe(0);
      expect(result.chainIntegrity.eventsChecked).toBe(0);
      expect(result.attestation).toContain("Events checked: 0.");
    } finally {
      db.close();
    }
  });
});
