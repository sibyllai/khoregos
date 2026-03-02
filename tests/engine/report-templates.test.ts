/**
 * Tests for standards-based audit report templates.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { generateAuditReport } from "../../src/engine/report.js";
import { sessionToDbRow, type Session } from "../../src/models/session.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createFixture(): { projectRoot: string; db: Db; sessionId: string } {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-report-template-test-"));
  cleanupPaths.push(projectRoot);

  const khoregosDir = path.join(projectRoot, ".khoregos");
  mkdirSync(khoregosDir, { recursive: true });

  const db = new Db(path.join(khoregosDir, "k6s.db"));
  db.connect();

  const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
  const session: Session = {
    id: sessionId,
    objective: "Template report validation",
    state: "completed",
    startedAt: "2026-02-20T12:00:00.000Z",
    endedAt: "2026-02-20T12:05:00.000Z",
    parentSessionId: null,
    configSnapshot: null,
    contextSummary: null,
    metadata: null,
    operator: "davy",
    hostname: "workstation",
    k6sVersion: "0.7.0",
    claudeCodeVersion: null,
    gitBranch: "main",
    gitSha: "abc123",
    gitDirty: false,
    traceId: "trace-template",
  };
  db.insert("sessions", sessionToDbRow(session));

  generateSigningKey(khoregosDir);
  const signingKey = loadSigningKey(khoregosDir);
  if (!signingKey) {
    throw new Error("signing key was not generated");
  }

  const logger = new AuditLogger(db, sessionId, session.traceId, signingKey);
  logger.start();
  logger.log({
    eventType: "session_start",
    action: "session started: template report validation",
    severity: "info",
  });
  logger.log({
    eventType: "tool_use",
    action: "tool use event",
    severity: "info",
  });
  logger.log({
    eventType: "gate_triggered",
    action: "sensitive annotation event",
    severity: "warning",
  });
  logger.log({
    eventType: "boundary_violation",
    action: "boundary violation event",
    severity: "critical",
  });
  logger.log({
    eventType: "session_pause",
    action: "pause event for unmapped coverage",
    severity: "info",
  });

  return { projectRoot, db, sessionId };
}

describe("generateAuditReport templates", () => {
  it("renders SOC 2 mapping with criteria codes and unmapped events", () => {
    const { projectRoot, db, sessionId } = createFixture();
    try {
      const report = generateAuditReport(db, sessionId, projectRoot, "soc2");
      expect(report).toContain("# Khoregos audit report — SOC 2");
      expect(report).toContain("## SOC 2 compliance mapping");
      expect(report).toContain("| Criteria | Description | Events | Evidence |");
      expect(report).toContain("CC6.1");
      expect(report).toContain("CC6.3");
      expect(report).toContain("CC8.1");
      expect(report).toContain("Unmapped event types observed: session_pause.");
    } finally {
      db.close();
    }
  });

  it("renders ISO 27001 mapping with control IDs", () => {
    const { projectRoot, db, sessionId } = createFixture();
    try {
      const report = generateAuditReport(db, sessionId, projectRoot, "iso27001");
      expect(report).toContain("# Khoregos audit report — ISO 27001");
      expect(report).toContain("## ISO 27001 compliance mapping");
      expect(report).toContain("| Control | Description | Events | Evidence |");
      expect(report).toContain("A.12.4.1");
      expect(report).toContain("A.9.4.1");
      expect(report).toContain("A.14.2.2");
      expect(report).toContain("Unmapped event types observed: session_pause.");
    } finally {
      db.close();
    }
  });

  it("keeps generic reports unchanged with no compliance mapping section", () => {
    const { projectRoot, db, sessionId } = createFixture();
    try {
      const report = generateAuditReport(db, sessionId, projectRoot, "generic");
      expect(report).toContain("# Khoregos audit report");
      expect(report).not.toContain("## SOC 2 compliance mapping");
      expect(report).not.toContain("## ISO 27001 compliance mapping");
      expect(report).not.toContain("Unmapped event types observed:");
    } finally {
      db.close();
    }
  });
});
