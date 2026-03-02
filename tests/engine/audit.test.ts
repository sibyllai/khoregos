/**
 * Tests for AuditLogger: chain continuity, HMAC, getEvents, pruneAuditEvents.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import {
  AuditLogger,
  pruneAuditEvents,
  pruneSessions,
  setWebhookDispatcher,
} from "../../src/engine/audit.js";
import { setPluginManager, type PluginManager } from "../../src/engine/plugins.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import { randomBytes } from "node:crypto";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { sessionToDbRow } from "../../src/models/session.js";
import type { Session } from "../../src/models/session.js";
import { WebhookDispatcher } from "../../src/engine/webhooks.js";
import { vi } from "vitest";

describe("AuditLogger", () => {
  let db: Db;
  let sessionId: string;
  let signingKeyDir: string;
  let signingKey: Buffer | null = null;

  beforeAll(() => {
    const dbPath = getTempDbPath();
    db = new Db(dbPath);
    db.connect();
    sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const session: Session = {
      id: sessionId,
      objective: "audit test",
      state: "active",
      startedAt: new Date().toISOString(),
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
      traceId: "trace-123",
    };
    db.insert("sessions", sessionToDbRow(session));
    signingKeyDir = mkdtempSync(path.join(tmpdir(), "k6s-sign-"));
    generateSigningKey(signingKeyDir);
    signingKey = loadSigningKey(signingKeyDir);
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
    rmSync(signingKeyDir, { recursive: true });
  });

  describe("log without signing key", () => {
    it("logs event with null hmac when no signing key", () => {
      const logger = new AuditLogger(db, sessionId, null, null);
      logger.start();
      const event = logger.log({
        eventType: "tool_use",
        action: "read_file",
      });
      expect(event.hmac).toBeNull();
      expect(event.sequence).toBeGreaterThanOrEqual(1);
      expect(event.sessionId).toBe(sessionId);
    });
  });

  describe("log with signing key", () => {
    it("logs event with HMAC and includes trace_id in details", () => {
      const logger = new AuditLogger(
        db,
        sessionId,
        "trace-123",
        signingKey!,
      );
      logger.start();
      const event = logger.log({
        eventType: "session_start",
        action: "start",
        details: { foo: "bar" },
      });
      expect(event.hmac).not.toBeNull();
      expect(event.hmac).toMatch(/^[a-f0-9]{64}$/);
      expect(event.details).toContain("trace_id");
      expect(event.details).toContain("trace-123");
    });

    it("chains HMAC correctly across multiple events", () => {
      const sid = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
      db.insert("sessions", sessionToDbRow({
        id: sid,
        objective: "chain test",
        state: "active",
        startedAt: new Date().toISOString(),
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
      const logger = new AuditLogger(db, sid, null, signingKey!);
      logger.start();
      logger.log({ eventType: "session_start", action: "start" });
      const e2 = logger.log({ eventType: "tool_use", action: "run" });
      const e3 = logger.log({ eventType: "tool_use", action: "run2" });
      expect(e2.hmac).not.toBeNull();
      expect(e3.hmac).not.toBeNull();
      expect(e2.hmac).not.toBe(e3.hmac);
    });

    it("start() resumes sequence from existing events", () => {
      const logger = new AuditLogger(db, sessionId, null, signingKey!);
      logger.start();
      const countBefore = logger.getEventCount();
      const event = logger.log({
        eventType: "log",
        action: "resume test",
      });
      expect(event.sequence).toBe(countBefore + 1);
    });

    it("creates periodic timestamp anchors when interval_events is reached", async () => {
      const sid = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
      const serverScript = [
        "const http=require('node:http');",
        "const port=18789;",
        "const server=http.createServer((req,res)=>{",
        "if(req.method!=='POST'){res.writeHead(404);res.end();return;}",
        "const chunks=[];",
        "req.on('data',c=>chunks.push(Buffer.from(c)));",
        "req.on('end',()=>{const body=Buffer.concat(chunks);res.writeHead(200,{'Content-Type':'application/timestamp-reply'});res.end(body);});",
        "});",
        "server.listen(port,'127.0.0.1',()=>console.log('ready'));",
      ].join("");
      const server = spawn(process.execPath, ["-e", serverScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          if (chunk.toString("utf-8").includes("ready")) {
            server.stdout.off("data", onData);
            resolve();
          }
        };
        server.stdout.on("data", onData);
        server.once("error", reject);
        server.once("exit", (code) => {
          if (code !== null && code !== 0) {
            reject(new Error(`mock tsa exited early with code ${code}`));
          }
        });
      });
      const configSnapshot = JSON.stringify({
        project: { name: "test" },
        observability: {
          timestamping: {
            enabled: true,
            authority_url: "http://127.0.0.1:18789/tsr",
            interval_events: 2,
            strict_verify: false,
          },
        },
      });
      db.insert("sessions", sessionToDbRow({
        id: sid,
        objective: "auto timestamp",
        state: "active",
        startedAt: new Date().toISOString(),
        endedAt: null,
        parentSessionId: null,
        configSnapshot,
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

      try {
        const logger = new AuditLogger(db, sid, null, signingKey!);
        logger.start();
        logger.log({ eventType: "session_start", action: "start" });
        logger.log({ eventType: "tool_use", action: "run" });

        let anchored = false;
        for (let i = 0; i < 20; i += 1) {
          const row = db.fetchOne(
            "SELECT event_sequence FROM timestamps WHERE session_id = ? ORDER BY event_sequence DESC LIMIT 1",
            [sid],
          ) as { event_sequence?: number } | undefined;
          if ((row?.event_sequence ?? 0) === 2) {
            anchored = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(anchored).toBe(true);
      } finally {
        server.kill();
      }
    });

    it("does not auto-anchor before interval_events threshold", async () => {
      const sid = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
      const configSnapshot = JSON.stringify({
        project: { name: "test" },
        observability: {
          timestamping: {
            enabled: true,
            authority_url: "http://127.0.0.1:9/tsr",
            interval_events: 3,
            strict_verify: false,
          },
        },
      });
      db.insert("sessions", sessionToDbRow({
        id: sid,
        objective: "auto timestamp threshold",
        state: "active",
        startedAt: new Date().toISOString(),
        endedAt: null,
        parentSessionId: null,
        configSnapshot,
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

      const logger = new AuditLogger(db, sid, null, signingKey!);
      logger.start();
      logger.log({ eventType: "session_start", action: "start" });
      logger.log({ eventType: "tool_use", action: "run" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const row = db.fetchOne(
        "SELECT COUNT(*) as count FROM timestamps WHERE session_id = ?",
        [sid],
      ) as { count: number };
      expect(row.count).toBe(0);
    });

    it("dispatches webhook side effects after persisting an audit event", () => {
      const dispatcher = new WebhookDispatcher([]);
      const dispatchSpy = vi
        .spyOn(dispatcher, "dispatch")
        .mockImplementation(() => {});
      setWebhookDispatcher(dispatcher);
      try {
        const logger = new AuditLogger(db, sessionId, "trace-123", signingKey!);
        logger.start();
        const event = logger.log({
          eventType: "tool_use",
          action: "webhook dispatch test",
        });
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        expect(dispatchSpy).toHaveBeenCalledWith(event, {
          sessionId,
          traceId: "trace-123",
        });
      } finally {
        setWebhookDispatcher(null);
      }
    });

    it("dispatches plugin audit hooks after persisting an audit event", () => {
      let seenPersistedEvent = false;
      const pluginManager = {
        callAuditEvent(event: { id: string }): void {
          const row = db.fetchOne(
            "SELECT COUNT(*) as count FROM audit_events WHERE id = ?",
            [event.id],
          );
          seenPersistedEvent = ((row?.count as number) ?? 0) === 1;
        },
      } as PluginManager;

      setPluginManager(pluginManager);
      try {
        const logger = new AuditLogger(db, sessionId, "trace-123", signingKey!);
        logger.start();
        logger.log({
          eventType: "tool_use",
          action: "plugin dispatch test",
        });
        expect(seenPersistedEvent).toBe(true);
      } finally {
        setPluginManager(null);
      }
    });
  });

  describe("getEvents and getEventCount", () => {
    it("getEventCount returns count for session", () => {
      const logger = new AuditLogger(db, sessionId, null, null);
      logger.start();
      const count = logger.getEventCount();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("getEvents returns events ordered by sequence desc", () => {
      const logger = new AuditLogger(db, sessionId, null, null);
      logger.start();
      const events = logger.getEvents({ limit: 10 });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence).toBeLessThanOrEqual(events[i - 1].sequence);
      }
    });

    it("getEvents filters by eventType when provided", () => {
      const logger = new AuditLogger(db, sessionId, null, null);
      const events = logger.getEvents({ eventType: "session_start", limit: 5 });
      events.forEach((e) => expect(e.eventType).toBe("session_start"));
    });
  });
});

describe("pruneAuditEvents", () => {
  let db: Db;
  let sessionId: string;

  beforeAll(() => {
    const dbPath = getTempDbPath();
    db = new Db(dbPath);
    db.connect();
    sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAP";
    db.insert("sessions", sessionToDbRow({
      id: sessionId,
      objective: "prune test",
      state: "completed",
      startedAt: "2020-01-01T00:00:00.000Z",
      endedAt: "2020-01-02T00:00:00.000Z",
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
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("dry run returns counts without deleting", () => {
    const before = db.fetchOne(
      "SELECT COUNT(*) as c FROM audit_events",
    ) as { c: number };
    const result = pruneAuditEvents(db, "2025-01-01T00:00:00.000Z", true);
    expect(result).toHaveProperty("eventsDeleted");
    expect(result).toHaveProperty("sessionsPruned");
    const after = db.fetchOne(
      "SELECT COUNT(*) as c FROM audit_events",
    ) as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("deletes events before given date", () => {
    const logger = new AuditLogger(db, sessionId, null, null);
    logger.start();
    logger.log({
      eventType: "tool_use",
      action: "old",
    });
    const oldDate = "2019-06-01T00:00:00.000Z";
    const result = pruneAuditEvents(db, oldDate, false);
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(0);
  });
});

describe("pruneSessions", () => {
  let db: Db;
  const staleSessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAS";
  const activeSessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAT";

  beforeAll(() => {
    const dbPath = getTempDbPath();
    db = new Db(dbPath);
    db.connect();

    db.insert("sessions", sessionToDbRow({
      id: staleSessionId,
      objective: "stale completed session",
      state: "completed",
      startedAt: "2020-01-01T00:00:00.000Z",
      endedAt: "2020-01-02T00:00:00.000Z",
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
    db.insert("sessions", sessionToDbRow({
      id: activeSessionId,
      objective: "active session",
      state: "active",
      startedAt: "2020-01-01T00:00:00.000Z",
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

    db.insert("agents", {
      id: "agent-stale",
      session_id: staleSessionId,
      name: "stale-agent",
      role: "teammate",
      state: "active",
      spawned_at: "2020-01-01T00:00:00.000Z",
    });
    db.insert("audit_events", {
      id: "audit-stale",
      sequence: 1,
      session_id: staleSessionId,
      agent_id: null,
      timestamp: "2020-01-01T00:00:00.000Z",
      event_type: "session_start",
      action: "stale start",
      details: null,
      files_affected: null,
      gate_id: null,
      hmac: null,
      severity: "info",
    });
    db.insert("context_store", {
      key: "resume_context",
      session_id: staleSessionId,
      agent_id: null,
      value: "context",
      updated_at: "2020-01-01T00:00:00.000Z",
    });
    db.insert("boundary_violations", {
      id: "vio-stale",
      session_id: staleSessionId,
      agent_id: null,
      timestamp: "2020-01-01T00:00:00.000Z",
      file_path: "secret.txt",
      violation_type: "forbidden_path",
      enforcement_action: "logged",
      details: null,
    });
    db.insert("file_locks", {
      path: "lock.file",
      session_id: staleSessionId,
      agent_id: "agent-stale",
      acquired_at: "2020-01-01T00:00:00.000Z",
      expires_at: null,
    });
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("dry run returns number of completed sessions that would be pruned", () => {
    const result = pruneSessions(db, "2025-01-01T00:00:00.000Z", true);
    expect(result.sessionsPruned).toBeGreaterThanOrEqual(1);
    const staleStillExists = db.fetchOne(
      "SELECT COUNT(*) as c FROM sessions WHERE id = ?",
      [staleSessionId],
    ) as { c: number };
    expect(staleStillExists.c).toBe(1);
  });

  it("prunes completed sessions and cascade deletes associated records", () => {
    const result = pruneSessions(db, "2025-01-01T00:00:00.000Z", false);
    expect(result.sessionsPruned).toBeGreaterThanOrEqual(1);

    const staleSession = db.fetchOne(
      "SELECT COUNT(*) as c FROM sessions WHERE id = ?",
      [staleSessionId],
    ) as { c: number };
    const staleAudit = db.fetchOne(
      "SELECT COUNT(*) as c FROM audit_events WHERE session_id = ?",
      [staleSessionId],
    ) as { c: number };
    const staleContext = db.fetchOne(
      "SELECT COUNT(*) as c FROM context_store WHERE session_id = ?",
      [staleSessionId],
    ) as { c: number };
    const staleAgents = db.fetchOne(
      "SELECT COUNT(*) as c FROM agents WHERE session_id = ?",
      [staleSessionId],
    ) as { c: number };

    expect(staleSession.c).toBe(0);
    expect(staleAudit.c).toBe(0);
    expect(staleContext.c).toBe(0);
    expect(staleAgents.c).toBe(0);
  });

  it("does not prune active sessions regardless of age", () => {
    const result = pruneSessions(db, "2025-01-01T00:00:00.000Z", false);
    expect(result.sessionsPruned).toBe(0);
    const activeStillExists = db.fetchOne(
      "SELECT COUNT(*) as c FROM sessions WHERE id = ?",
      [activeSessionId],
    ) as { c: number };
    expect(activeStillExists.c).toBe(1);
  });
});
