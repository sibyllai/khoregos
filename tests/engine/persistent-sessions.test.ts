/**
 * Tests for persistent session behavior: auto-session creation,
 * session resumption from paused state, stale detection, and
 * the end_on_claude_exit=false default.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import { SessionConfigSchema } from "../../src/models/config.js";

describe("persistent sessions", () => {
  let dbPath: string;
  let db: Db;
  let sm: StateManager;

  beforeAll(() => {
    dbPath = getTempDbPath();
  });

  afterAll(() => {
    cleanupTempDir();
  });

  beforeEach(() => {
    dbPath = getTempDbPath();
    db = new Db(dbPath);
    db.connect();
    sm = new StateManager(db, "/tmp/test-project");
  });

  describe("config defaults", () => {
    it("end_on_claude_exit defaults to false", () => {
      const config = SessionConfigSchema.parse({});
      expect(config.end_on_claude_exit).toBe(false);
    });

    it("stale_timeout_hours defaults to 24", () => {
      const config = SessionConfigSchema.parse({});
      expect(config.stale_timeout_hours).toBe(24);
    });

    it("stale_timeout_hours can be set to 0 to disable", () => {
      const config = SessionConfigSchema.parse({ stale_timeout_hours: 0 });
      expect(config.stale_timeout_hours).toBe(0);
    });

    it("end_on_claude_exit can still be set to true", () => {
      const config = SessionConfigSchema.parse({ end_on_claude_exit: true });
      expect(config.end_on_claude_exit).toBe(true);
    });
  });

  describe("getResumableSession", () => {
    it("returns active sessions", () => {
      const session = sm.createSession({ objective: "test" });
      sm.markSessionActive(session.id);
      const found = sm.getResumableSession();
      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
      db.close();
    });

    it("returns paused sessions", () => {
      const session = sm.createSession({ objective: "test" });
      sm.markSessionActive(session.id);
      sm.markSessionPaused(session.id);
      const found = sm.getResumableSession();
      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
      expect(found!.state).toBe("paused");
      db.close();
    });

    it("returns created sessions", () => {
      const session = sm.createSession({ objective: "test" });
      const found = sm.getResumableSession();
      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
      expect(found!.state).toBe("created");
      db.close();
    });

    it("does not return completed sessions", () => {
      const session = sm.createSession({ objective: "test" });
      sm.markSessionCompleted(session.id);
      const found = sm.getResumableSession();
      expect(found).toBeNull();
      db.close();
    });

    it("returns the most recent resumable session", () => {
      const s1 = sm.createSession({ objective: "first" });
      sm.markSessionActive(s1.id);
      sm.markSessionPaused(s1.id);
      // Backdate s1 to guarantee ordering (ULID same-ms race).
      db.update(
        "sessions",
        { started_at: new Date(Date.now() - 60_000).toISOString() },
        "id = ?",
        [s1.id],
      );

      const s2 = sm.createSession({ objective: "second" });
      sm.markSessionActive(s2.id);

      const found = sm.getResumableSession();
      expect(found).not.toBeNull();
      expect(found!.id).toBe(s2.id);
      db.close();
    });
  });

  describe("session pause and resume lifecycle", () => {
    it("paused session can be re-activated", () => {
      const session = sm.createSession({ objective: "test lifecycle" });
      sm.markSessionActive(session.id);
      sm.markSessionPaused(session.id);

      const paused = sm.getSession(session.id);
      expect(paused!.state).toBe("paused");

      sm.markSessionActive(session.id);
      const resumed = sm.getSession(session.id);
      expect(resumed!.state).toBe("active");
      db.close();
    });

    it("audit events are recorded during paused -> active transition", () => {
      const session = sm.createSession({ objective: "test audit" });
      sm.markSessionActive(session.id);
      sm.markSessionPaused(session.id);
      sm.markSessionActive(session.id);

      const logger = new AuditLogger(db, session.id, session.traceId, null);
      logger.start();
      logger.log({
        eventType: "session_resume",
        action: "session resumed by hook",
        details: { auto_resumed: true },
      });
      logger.stop();

      const events = logger.getEvents({ eventType: "session_resume" });
      expect(events.length).toBe(1);
      expect(events[0].action).toContain("resumed");
      db.close();
    });
  });

  describe("auto-session objective generation", () => {
    it("uses previous session objective for continuation", () => {
      const s1 = sm.createSession({ objective: "implement auth flow" });
      sm.markSessionCompleted(s1.id);

      const latest = sm.getLatestSession();
      const objective = latest
        ? `continuation of: ${latest.objective}`
        : "auto-session";
      expect(objective).toBe("continuation of: implement auth flow");
      db.close();
    });

    it("creates parent session link", () => {
      const parent = sm.createSession({ objective: "original" });
      sm.markSessionCompleted(parent.id);

      const child = sm.createSession({
        objective: `continuation of: ${parent.objective}`,
        parentSessionId: parent.id,
      });

      const fetched = sm.getSession(child.id);
      expect(fetched!.parentSessionId).toBe(parent.id);
      db.close();
    });
  });

  describe("stale session detection", () => {
    it("detects sessions older than threshold", () => {
      const session = sm.createSession({ objective: "old session" });
      // Manually backdate the session by updating started_at.
      db.update(
        "sessions",
        { started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
        "id = ?",
        [session.id],
      );

      const fetched = sm.getSession(session.id)!;
      const ageMs = Date.now() - new Date(fetched.startedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      expect(ageHours).toBeGreaterThan(24);
      db.close();
    });

    it("does not flag sessions within threshold", () => {
      const session = sm.createSession({ objective: "fresh session" });
      const fetched = sm.getSession(session.id)!;
      const ageMs = Date.now() - new Date(fetched.startedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      expect(ageHours).toBeLessThan(1);
      db.close();
    });
  });
});
