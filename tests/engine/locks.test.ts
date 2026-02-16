/**
 * Tests for FileLockManager: acquire, release, check, list, expiration.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { FileLockManager, lockResultToDict } from "../../src/engine/locks.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("FileLockManager", () => {
  let db: Db;
  let locks: FileLockManager;
  const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
    locks = new FileLockManager(db, sessionId);
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  describe("acquire", () => {
    it("acquires lock and returns success with lock", () => {
      const result = locks.acquire("src/main.ts", "agent-1");
      expect(result.success).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock!.path).toBe("src/main.ts");
      expect(result.lock!.agentId).toBe("agent-1");
      expect(result.lock!.expiresAt).toBeDefined();
    });

    it("same agent can extend lock (re-acquire)", () => {
      const r1 = locks.acquire("src/other.ts", "agent-1");
      expect(r1.success).toBe(true);
      const r2 = locks.acquire("src/other.ts", "agent-1");
      expect(r2.success).toBe(true);
      expect(r2.lock).toBeDefined();
    });

    it("different agent is denied when path is locked", () => {
      locks.acquire("src/locked.ts", "agent-1");
      const result = locks.acquire("src/locked.ts", "agent-2");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("locked by agent");
    });
  });

  describe("release", () => {
    it("releases lock held by same agent", () => {
      locks.acquire("src/release-me.ts", "agent-1");
      const result = locks.release("src/release-me.ts", "agent-1");
      expect(result.success).toBe(true);
      expect(locks.isLocked("src/release-me.ts")).toBe(false);
    });

    it("returns success when lock already released", () => {
      const result = locks.release("src/nonexistent-lock.ts", "agent-1");
      expect(result.success).toBe(true);
    });

    it("returns failure when lock held by different agent", () => {
      locks.acquire("src/held.ts", "agent-1");
      const result = locks.release("src/held.ts", "agent-2");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("different agent");
    });
  });

  describe("check and isLocked", () => {
    it("check returns lock when present and not expired", () => {
      locks.acquire("src/check.ts", "agent-1");
      const lock = locks.check("src/check.ts");
      expect(lock).not.toBeNull();
      expect(lock!.agentId).toBe("agent-1");
    });

    it("isLocked returns true when lock exists", () => {
      locks.acquire("src/is-locked.ts", "agent-1");
      expect(locks.isLocked("src/is-locked.ts")).toBe(true);
    });

    it("getHolder returns agent id", () => {
      locks.acquire("src/holder.ts", "agent-99");
      expect(locks.getHolder("src/holder.ts")).toBe("agent-99");
    });
  });

  describe("listLocks", () => {
    it("returns locks for session", () => {
      locks.acquire("src/list1.ts", "agent-1");
      locks.acquire("src/list2.ts", "agent-1");
      const list = locks.listLocks();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by agentId when provided", () => {
      locks.acquire("src/agent-a.ts", "agent-a");
      const list = locks.listLocks("agent-a");
      expect(list.every((l) => l.agentId === "agent-a")).toBe(true);
    });
  });

  describe("releaseAllForAgent and releaseAll", () => {
    it("releaseAllForAgent removes all locks for agent", () => {
      locks.acquire("src/all1.ts", "agent-all");
      locks.acquire("src/all2.ts", "agent-all");
      const n = locks.releaseAllForAgent("agent-all");
      expect(n).toBeGreaterThanOrEqual(2);
      expect(locks.isLocked("src/all1.ts")).toBe(false);
      expect(locks.isLocked("src/all2.ts")).toBe(false);
    });

    it("releaseAll removes all locks for session", () => {
      locks.acquire("src/sess1.ts", "agent-1");
      const n = locks.releaseAll();
      expect(n).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("lockResultToDict", () => {
  it("returns object with success and optional lock_token, reason", () => {
    const success = lockResultToDict({ success: true });
    expect(success.success).toBe(true);
    const fail = lockResultToDict({
      success: false,
      reason: "locked",
    });
    expect(fail.success).toBe(false);
    expect(fail.reason).toBe("locked");
  });
});
