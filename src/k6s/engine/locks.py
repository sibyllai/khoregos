"""File lock manager for coordinating file access between agents."""

from datetime import datetime, timedelta
from typing import Any

from k6s.models.context import FileLock
from k6s.store.db import Database


class LockResult:
    """Result of a lock acquisition attempt."""

    def __init__(
        self,
        success: bool,
        lock: FileLock | None = None,
        reason: str | None = None,
    ):
        self.success = success
        self.lock = lock
        self.reason = reason

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for MCP response."""
        result: dict[str, Any] = {"success": self.success}
        if self.lock:
            result["lock_token"] = self.lock.path
            result["expires_at"] = (
                self.lock.expires_at.isoformat() if self.lock.expires_at else None
            )
        if self.reason:
            result["reason"] = self.reason
        return result


class FileLockManager:
    """Manage exclusive file locks for coordinating agent access.

    Prevents multiple agents from editing the same file simultaneously.
    Locks have optional expiration to prevent deadlocks.
    """

    DEFAULT_LOCK_DURATION_SECONDS = 300  # 5 minutes

    def __init__(self, db: Database, session_id: str):
        self.db = db
        self.session_id = session_id

    async def acquire(
        self,
        path: str,
        agent_id: str,
        duration_seconds: int | None = None,
    ) -> LockResult:
        """Attempt to acquire a lock on a file.

        Uses BEGIN IMMEDIATE to serialize concurrent lock attempts
        and prevent two agents from both acquiring the same lock.

        Args:
            path: The file path to lock.
            agent_id: The agent requesting the lock.
            duration_seconds: Lock duration (default: 5 minutes).

        Returns:
            LockResult indicating success or failure.
        """
        async with self.db.transaction() as conn:
            # BEGIN IMMEDIATE ensures exclusive write access from the start,
            # preventing TOCTOU races between the SELECT and INSERT.
            await conn.execute("BEGIN IMMEDIATE")

            # Check for existing lock within the transaction
            cursor = await conn.execute(
                "SELECT * FROM file_locks WHERE path = ? AND session_id = ?",
                (path, self.session_id),
            )
            row = await cursor.fetchone()
            existing = FileLock.from_db_row(dict(row)) if row else None

            if existing:
                if existing.is_expired:
                    await conn.execute(
                        "DELETE FROM file_locks WHERE path = ? AND session_id = ?",
                        (path, self.session_id),
                    )
                elif existing.agent_id != agent_id:
                    return LockResult(
                        success=False,
                        reason=f"File locked by agent {existing.agent_id}",
                    )
                else:
                    # Same agent already has the lock, extend it
                    duration = duration_seconds or self.DEFAULT_LOCK_DURATION_SECONDS
                    new_expires = datetime.utcnow() + timedelta(seconds=duration)
                    await conn.execute(
                        "UPDATE file_locks SET expires_at = ? WHERE path = ? AND session_id = ?",
                        (new_expires.isoformat(), path, self.session_id),
                    )
                    existing.expires_at = new_expires
                    return LockResult(success=True, lock=existing)

            # Create new lock
            duration = duration_seconds or self.DEFAULT_LOCK_DURATION_SECONDS
            expires_at = datetime.utcnow() + timedelta(seconds=duration)

            lock = FileLock(
                path=path,
                session_id=self.session_id,
                agent_id=agent_id,
                expires_at=expires_at,
            )

            data = lock.to_db_row()
            columns = ", ".join(data.keys())
            placeholders = ", ".join("?" for _ in data)
            await conn.execute(
                f"INSERT OR REPLACE INTO file_locks ({columns}) VALUES ({placeholders})",
                tuple(data.values()),
            )

            return LockResult(success=True, lock=lock)

    async def release(self, path: str, agent_id: str) -> LockResult:
        """Release a lock on a file.

        Args:
            path: The file path to unlock.
            agent_id: The agent releasing the lock.

        Returns:
            LockResult indicating success or failure.
        """
        existing = await self._get_lock(path)
        if existing is None:
            return LockResult(success=True, reason="Lock not found (already released)")

        if existing.agent_id != agent_id:
            return LockResult(
                success=False,
                reason=f"Lock held by different agent: {existing.agent_id}",
            )

        await self._release_lock(path)
        return LockResult(success=True)

    async def check(self, path: str) -> FileLock | None:
        """Check if a file is locked.

        Returns the lock if held (and not expired), None otherwise.
        """
        lock = await self._get_lock(path)
        if lock and lock.is_expired:
            await self._release_lock(path)
            return None
        return lock

    async def is_locked(self, path: str) -> bool:
        """Check if a file is currently locked."""
        return await self.check(path) is not None

    async def get_holder(self, path: str) -> str | None:
        """Get the agent ID holding a lock on a file."""
        lock = await self.check(path)
        return lock.agent_id if lock else None

    async def list_locks(self, agent_id: str | None = None) -> list[FileLock]:
        """List all active locks in this session.

        Args:
            agent_id: Optional filter by agent.

        Returns:
            List of active FileLock objects.
        """
        if agent_id:
            sql = """
                SELECT * FROM file_locks
                WHERE session_id = ? AND agent_id = ?
            """
            params = (self.session_id, agent_id)
        else:
            sql = """
                SELECT * FROM file_locks
                WHERE session_id = ?
            """
            params = (self.session_id,)

        rows = await self.db.fetch_all(sql, params)
        locks = [FileLock.from_db_row(row) for row in rows]

        # Filter out expired locks and clean them up
        active_locks = []
        for lock in locks:
            if lock.is_expired:
                await self._release_lock(lock.path)
            else:
                active_locks.append(lock)

        return active_locks

    async def release_all_for_agent(self, agent_id: str) -> int:
        """Release all locks held by an agent.

        Returns the number of locks released.
        """
        return await self.db.delete(
            "file_locks",
            "session_id = ? AND agent_id = ?",
            (self.session_id, agent_id),
        )

    async def release_all(self) -> int:
        """Release all locks in this session.

        Returns the number of locks released.
        """
        return await self.db.delete(
            "file_locks",
            "session_id = ?",
            (self.session_id,),
        )

    async def _get_lock(self, path: str) -> FileLock | None:
        """Get a lock by path."""
        row = await self.db.fetch_one(
            "SELECT * FROM file_locks WHERE path = ? AND session_id = ?",
            (path, self.session_id),
        )
        if row is None:
            return None
        return FileLock.from_db_row(row)

    async def _release_lock(self, path: str) -> None:
        """Release a lock by path."""
        await self.db.delete(
            "file_locks",
            "path = ? AND session_id = ?",
            (path, self.session_id),
        )

    async def _extend_lock(
        self,
        lock: FileLock,
        duration_seconds: int | None,
    ) -> LockResult:
        """Extend an existing lock's expiration."""
        duration = duration_seconds or self.DEFAULT_LOCK_DURATION_SECONDS
        new_expires = datetime.utcnow() + timedelta(seconds=duration)

        await self.db.update(
            "file_locks",
            {"expires_at": new_expires.isoformat()},
            "path = ? AND session_id = ?",
            (lock.path, self.session_id),
        )

        lock.expires_at = new_expires
        return LockResult(success=True, lock=lock)
