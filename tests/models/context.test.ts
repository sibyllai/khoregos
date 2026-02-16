/**
 * Tests for context model: ContextEntry, FileLock, BoundaryViolation, toDbRow/fromDbRow, isLockExpired.
 */

import { describe, it, expect } from "vitest";
import {
  contextEntryToDbRow,
  contextEntryFromDbRow,
  fileLockToDbRow,
  fileLockFromDbRow,
  isLockExpired,
  boundaryViolationToDbRow,
  boundaryViolationFromDbRow,
  type ContextEntry,
  type FileLock,
  type BoundaryViolation,
} from "../../src/models/context.js";

describe("context model", () => {
  describe("ContextEntry", () => {
    it("roundtrips to db row and back", () => {
      const entry: ContextEntry = {
        key: "k1",
        sessionId: "s1",
        agentId: "a1",
        value: "v1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const row = contextEntryToDbRow(entry);
      expect(row.key).toBe(entry.key);
      expect(row.session_id).toBe(entry.sessionId);
      const back = contextEntryFromDbRow(row);
      expect(back.key).toBe(entry.key);
      expect(back.agentId).toBe(entry.agentId);
    });
  });

  describe("FileLock", () => {
    it("roundtrips to db row and back", () => {
      const lock: FileLock = {
        path: "src/main.ts",
        sessionId: "s1",
        agentId: "a1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      };
      const row = fileLockToDbRow(lock);
      expect(row.path).toBe(lock.path);
      expect(row.expires_at).toBe(lock.expiresAt);
      const back = fileLockFromDbRow(row);
      expect(back.path).toBe(lock.path);
      expect(back.expiresAt).toBe(lock.expiresAt);
    });

    describe("isLockExpired", () => {
      it("returns false when expiresAt is null", () => {
        expect(isLockExpired({ expiresAt: null } as FileLock)).toBe(false);
      });

      it("returns false when expiresAt is in future", () => {
        const future = new Date(Date.now() + 60_000).toISOString();
        expect(isLockExpired({ expiresAt: future } as FileLock)).toBe(false);
      });

      it("returns true when expiresAt is in past", () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        expect(isLockExpired({ expiresAt: past } as FileLock)).toBe(true);
      });
    });
  });

  describe("BoundaryViolation", () => {
    it("roundtrips to db row and back", () => {
      const v: BoundaryViolation = {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sessionId: "s1",
        agentId: "a1",
        timestamp: "2026-01-01T00:00:00.000Z",
        filePath: "/tmp/out",
        violationType: "forbidden",
        enforcementAction: "logged",
        details: '{"pattern":".env"}',
      };
      const row = boundaryViolationToDbRow(v);
      expect(row.file_path).toBe(v.filePath);
      expect(row.violation_type).toBe(v.violationType);
      const back = boundaryViolationFromDbRow(row);
      expect(back.filePath).toBe(v.filePath);
      expect(back.details).toBe(v.details);
    });
  });
});
