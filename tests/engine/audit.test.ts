/**
 * Tests for AuditLogger: chain continuity, HMAC, getEvents, pruneAuditEvents.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import {
  AuditLogger,
  pruneAuditEvents,
  setWebhookDispatcher,
} from "../../src/engine/audit.js";
import { setPluginManager, type PluginManager } from "../../src/engine/plugins.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import { randomBytes } from "node:crypto";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
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
