/**
 * File lock manager for coordinating file access between agents.
 *
 * better-sqlite3 transactions are naturally serialized (single-threaded + sync),
 * so no TOCTOU race is possible.
 */

import type { Db } from "../store/db.js";
import {
  type FileLock,
  fileLockFromDbRow,
  fileLockToDbRow,
  isLockExpired,
} from "../models/context.js";

export interface LockResult {
  success: boolean;
  lock?: FileLock;
  reason?: string;
}

export function lockResultToDict(r: LockResult): Record<string, unknown> {
  const result: Record<string, unknown> = { success: r.success };
  if (r.lock) {
    result.lock_token = r.lock.path;
    result.expires_at = r.lock.expiresAt;
  }
  if (r.reason) result.reason = r.reason;
  return result;
}

const DEFAULT_LOCK_DURATION_SECONDS = 300;

export class FileLockManager {
  constructor(
    private db: Db,
    private sessionId: string,
  ) {}

  acquire(
    lockPath: string,
    agentId: string,
    durationSeconds?: number,
  ): LockResult {
    return this.db.transaction(() => {
      const row = this.db.fetchOne(
        "SELECT * FROM file_locks WHERE path = ? AND session_id = ?",
        [lockPath, this.sessionId],
      );
      const existing = row ? fileLockFromDbRow(row) : null;

      if (existing) {
        if (isLockExpired(existing)) {
          this.db.delete("file_locks", "path = ? AND session_id = ?", [
            lockPath,
            this.sessionId,
          ]);
        } else if (existing.agentId !== agentId) {
          return {
            success: false,
            reason: `File locked by agent ${existing.agentId}`,
          };
        } else {
          // Same agent — extend
          const duration = durationSeconds ?? DEFAULT_LOCK_DURATION_SECONDS;
          const newExpires = new Date(
            Date.now() + duration * 1000,
          ).toISOString();
          this.db.update(
            "file_locks",
            { expires_at: newExpires },
            "path = ? AND session_id = ?",
            [lockPath, this.sessionId],
          );
          return {
            success: true,
            lock: { ...existing, expiresAt: newExpires },
          };
        }
      }

      const duration = durationSeconds ?? DEFAULT_LOCK_DURATION_SECONDS;
      const lock: FileLock = {
        path: lockPath,
        sessionId: this.sessionId,
        agentId,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + duration * 1000).toISOString(),
      };

      this.db.insertOrReplace("file_locks", fileLockToDbRow(lock));
      return { success: true, lock };
    });
  }

  release(lockPath: string, agentId: string): LockResult {
    const existing = this.getLock(lockPath);
    if (!existing) {
      return { success: true, reason: "Lock not found (already released)" };
    }
    if (existing.agentId !== agentId) {
      return {
        success: false,
        reason: `Lock held by different agent: ${existing.agentId}`,
      };
    }
    this.deleteLock(lockPath);
    return { success: true };
  }

  check(lockPath: string): FileLock | null {
    const lock = this.getLock(lockPath);
    if (lock && isLockExpired(lock)) {
      this.deleteLock(lockPath);
      return null;
    }
    return lock;
  }

  isLocked(lockPath: string): boolean {
    return this.check(lockPath) !== null;
  }

  getHolder(lockPath: string): string | null {
    const lock = this.check(lockPath);
    return lock?.agentId ?? null;
  }

  listLocks(agentId?: string): FileLock[] {
    const rows = agentId
      ? this.db.fetchAll(
          "SELECT * FROM file_locks WHERE session_id = ? AND agent_id = ?",
          [this.sessionId, agentId],
        )
      : this.db.fetchAll("SELECT * FROM file_locks WHERE session_id = ?", [
          this.sessionId,
        ]);

    const locks = rows.map(fileLockFromDbRow);
    const active: FileLock[] = [];
    for (const lock of locks) {
      if (isLockExpired(lock)) {
        this.deleteLock(lock.path);
      } else {
        active.push(lock);
      }
    }
    return active;
  }

  releaseAllForAgent(agentId: string): number {
    return this.db.delete(
      "file_locks",
      "session_id = ? AND agent_id = ?",
      [this.sessionId, agentId],
    );
  }

  releaseAll(): number {
    return this.db.delete("file_locks", "session_id = ?", [this.sessionId]);
  }

  private getLock(lockPath: string): FileLock | null {
    const row = this.db.fetchOne(
      "SELECT * FROM file_locks WHERE path = ? AND session_id = ?",
      [lockPath, this.sessionId],
    );
    return row ? fileLockFromDbRow(row) : null;
  }

  private deleteLock(lockPath: string): void {
    this.db.delete("file_locks", "path = ? AND session_id = ?", [
      lockPath,
      this.sessionId,
    ]);
  }
}
