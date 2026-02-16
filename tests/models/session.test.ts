/**
 * Tests for session model: schema, toDbRow/fromDbRow, isSessionActive, sessionDurationSeconds.
 */

import { describe, it, expect } from "vitest";
import {
  SessionSchema,
  SessionState,
  sessionToDbRow,
  sessionFromDbRow,
  isSessionActive,
  sessionDurationSeconds,
  type Session,
} from "../../src/models/session.js";

describe("session model", () => {
  describe("SessionState", () => {
    it("accepts valid states", () => {
      expect(SessionState.parse("created")).toBe("created");
      expect(SessionState.parse("active")).toBe("active");
      expect(SessionState.parse("completed")).toBe("completed");
    });
  });

  describe("SessionSchema", () => {
    it("parses with defaults for optional fields", () => {
      const session = SessionSchema.parse({
        objective: "test",
      });
      expect(session.id).toBeDefined();
      expect(session.state).toBe("created");
      expect(session.endedAt).toBeNull();
      expect(session.gitDirty).toBe(false);
    });
  });

  describe("sessionToDbRow and sessionFromDbRow", () => {
    it("roundtrips session to db row and back", () => {
      const session: Session = {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        objective: "obj",
        state: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        parentSessionId: null,
        configSnapshot: null,
        contextSummary: null,
        metadata: null,
        operator: "alice",
        hostname: "host",
        k6sVersion: "0.3.0",
        claudeCodeVersion: null,
        gitBranch: "main",
        gitSha: "abc",
        gitDirty: true,
        traceId: "trace-1",
      };
      const row = sessionToDbRow(session);
      expect(row.objective).toBe(session.objective);
      expect(row.operator).toBe(session.operator);
      expect(row.git_dirty).toBe(1);

      const back = sessionFromDbRow(row);
      expect(back.id).toBe(session.id);
      expect(back.objective).toBe(session.objective);
      expect(back.operator).toBe(session.operator);
      expect(back.gitDirty).toBe(true);
      expect(back.traceId).toBe(session.traceId);
    });
  });

  describe("isSessionActive", () => {
    it("returns true for created and active", () => {
      expect(isSessionActive({ state: "created" } as Session)).toBe(true);
      expect(isSessionActive({ state: "active" } as Session)).toBe(true);
    });

    it("returns false for completed and failed", () => {
      expect(isSessionActive({ state: "completed" } as Session)).toBe(false);
      expect(isSessionActive({ state: "failed" } as Session)).toBe(false);
    });
  });

  describe("sessionDurationSeconds", () => {
    it("returns null when endedAt is null", () => {
      expect(
        sessionDurationSeconds({
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
        } as Session),
      ).toBeNull();
    });

    it("returns duration in seconds when both dates set", () => {
      const duration = sessionDurationSeconds({
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:01:30.000Z",
      } as Session);
      expect(duration).toBe(90);
    });
  });
});
