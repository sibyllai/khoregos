/**
 * Tests for structured audit report generation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { BoundaryEnforcer } from "../../src/engine/boundaries.js";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { generateAuditReport } from "../../src/engine/report.js";
import { sessionToDbRow, type Session } from "../../src/models/session.js";
import type { BoundaryConfig } from "../../src/models/config.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createProjectFixture(): { projectRoot: string; db: Db } {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-report-test-"));
  cleanupPaths.push(projectRoot);

  const khoregoDir = path.join(projectRoot, ".khoregos");
  mkdirSync(khoregoDir, { recursive: true });

  const dbPath = path.join(khoregoDir, "k6s.db");
  const db = new Db(dbPath);
  db.connect();
  return { projectRoot, db };
}

describe("generateAuditReport", () => {
  it("renders a deterministic markdown report with core sections", () => {
    const { projectRoot, db } = createProjectFixture();
    try {
      const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FZZ";
      const boundaries: BoundaryConfig[] = [
        {
          pattern: "*",
          allowed_paths: ["src/**"],
          forbidden_paths: ["secrets/**"],
          enforcement: "advisory",
        },
      ];

      const session: Session = {
        id: sessionId,
        objective: "Generate compliance report",
        state: "completed",
        startedAt: "2026-02-20T12:00:00.000Z",
        endedAt: "2026-02-20T12:10:05.000Z",
        parentSessionId: null,
        configSnapshot: JSON.stringify({ boundaries }),
        contextSummary: null,
        metadata: null,
        operator: "davy",
        hostname: "workstation",
        k6sVersion: "0.5.0",
        claudeCodeVersion: null,
        gitBranch: "main",
        gitSha: "abc123",
        gitDirty: false,
        traceId: "trace-123",
      };
      db.insert("sessions", sessionToDbRow(session));

      const sm = new StateManager(db, projectRoot);
      const alpha = sm.registerAgent({ sessionId, name: "alpha", role: "lead" });
      const beta = sm.registerAgent({ sessionId, name: "beta", role: "teammate" });

      generateSigningKey(path.join(projectRoot, ".khoregos"));
      const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
      expect(signingKey).not.toBeNull();

      const logger = new AuditLogger(db, sessionId, session.traceId, signingKey);
      logger.start();
      logger.log({
        eventType: "session_start",
        action: "Session started",
        severity: "info",
      });
      logger.log({
        eventType: "tool_use",
        action: "Updated source files",
        agentId: alpha.id,
        filesAffected: ["z.ts", "a.ts"],
        severity: "warning",
      });
      logger.log({
        eventType: "gate_triggered",
        action: "Sensitive file touched",
        agentId: beta.id,
        details: { rule_id: "security-files", file: "src/secret.key" },
        filesAffected: ["src/secret.key"],
        severity: "critical",
      });

      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      enforcer.recordViolation({
        filePath: "secrets/passwords.txt",
        agentId: alpha.id,
        violationType: "forbidden_path",
        enforcementAction: "blocked",
      });

      const report = generateAuditReport(db, sessionId, projectRoot);
      const reportAgain = generateAuditReport(db, sessionId, projectRoot);

      expect(report).toBe(reportAgain);
      expect(report).toContain("# Khoregos audit report");
      expect(report).toContain("## Session summary");
      expect(report).toContain("| Duration | 0h 10m 5s |");
      expect(report).toContain("## Audit chain integrity");
      expect(report).toContain("Status: valid.");
      expect(report).toContain("Errors: none.");
      expect(report).toContain("sensitive_needs_review");
      expect(report).toContain("| info | 1 |");
      expect(report).toContain("| warning | 1 |");
      expect(report).toContain("| critical | 1 |");
      expect(report).toContain("secrets/passwords.txt");

      const aIndex = report.indexOf("- a.ts");
      const secretIndex = report.indexOf("- src/secret.key");
      const zIndex = report.indexOf("- z.ts");
      expect(aIndex).toBeGreaterThanOrEqual(0);
      expect(secretIndex).toBeGreaterThan(aIndex);
      expect(zIndex).toBeGreaterThan(secretIndex);
    } finally {
      db.close();
    }
  });

  it("handles sessions with no signing key and no events", () => {
    const { projectRoot, db } = createProjectFixture();
    try {
      const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
      db.insert("sessions", sessionToDbRow({
        id: sessionId,
        objective: "Empty session",
        state: "active",
        startedAt: "2026-02-20T10:00:00.000Z",
        endedAt: null,
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
        traceId: null,
      }));

      const report = generateAuditReport(db, sessionId, projectRoot);
      expect(report).toContain("No signing key found. Run `k6s init` to generate one.");
      expect(report).toContain("No agents registered.");
      expect(report).toContain("No events recorded.");
      expect(report).toContain("No files recorded.");
      expect(report).toContain("No sensitive file annotations.");
      expect(report).toContain("No boundary configuration snapshot available for this session.");
    } finally {
      db.close();
    }
  });
});
