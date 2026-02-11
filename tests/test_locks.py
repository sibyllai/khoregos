"""Tests for the file lock manager."""

import pytest

from k6s.engine.locks import FileLockManager
from k6s.store.db import Database


@pytest.mark.asyncio
async def test_lock_acquire(db: Database, session_id: str) -> None:
    """Test acquiring a file lock."""
    lock_manager = FileLockManager(db, session_id)

    result = await lock_manager.acquire("src/file.py", "agent-1")

    assert result.success is True
    assert result.lock is not None
    assert result.lock.path == "src/file.py"
    assert result.lock.agent_id == "agent-1"


@pytest.mark.asyncio
async def test_lock_acquire_conflict(db: Database, session_id: str) -> None:
    """Test acquiring a lock that's already held."""
    lock_manager = FileLockManager(db, session_id)

    # First agent acquires lock
    result1 = await lock_manager.acquire("src/file.py", "agent-1")
    assert result1.success is True

    # Second agent tries to acquire same lock
    result2 = await lock_manager.acquire("src/file.py", "agent-2")
    assert result2.success is False
    assert "locked by" in result2.reason.lower()


@pytest.mark.asyncio
async def test_lock_acquire_same_agent(db: Database, session_id: str) -> None:
    """Test same agent acquiring lock extends it."""
    lock_manager = FileLockManager(db, session_id)

    # Agent acquires lock
    result1 = await lock_manager.acquire("src/file.py", "agent-1", duration_seconds=60)
    assert result1.success is True

    # Same agent acquires again (should extend)
    result2 = await lock_manager.acquire("src/file.py", "agent-1", duration_seconds=120)
    assert result2.success is True


@pytest.mark.asyncio
async def test_lock_release(db: Database, session_id: str) -> None:
    """Test releasing a file lock."""
    lock_manager = FileLockManager(db, session_id)

    # Acquire lock
    await lock_manager.acquire("src/file.py", "agent-1")

    # Release lock
    result = await lock_manager.release("src/file.py", "agent-1")
    assert result.success is True

    # Verify released
    lock = await lock_manager.check("src/file.py")
    assert lock is None


@pytest.mark.asyncio
async def test_lock_release_wrong_agent(db: Database, session_id: str) -> None:
    """Test releasing a lock held by another agent."""
    lock_manager = FileLockManager(db, session_id)

    # Agent 1 acquires lock
    await lock_manager.acquire("src/file.py", "agent-1")

    # Agent 2 tries to release
    result = await lock_manager.release("src/file.py", "agent-2")
    assert result.success is False


@pytest.mark.asyncio
async def test_lock_check(db: Database, session_id: str) -> None:
    """Test checking lock status."""
    lock_manager = FileLockManager(db, session_id)

    # No lock initially
    lock = await lock_manager.check("src/file.py")
    assert lock is None

    # Acquire lock
    await lock_manager.acquire("src/file.py", "agent-1")

    # Check returns the lock
    lock = await lock_manager.check("src/file.py")
    assert lock is not None
    assert lock.agent_id == "agent-1"


@pytest.mark.asyncio
async def test_lock_is_locked(db: Database, session_id: str) -> None:
    """Test is_locked helper."""
    lock_manager = FileLockManager(db, session_id)

    assert await lock_manager.is_locked("src/file.py") is False

    await lock_manager.acquire("src/file.py", "agent-1")

    assert await lock_manager.is_locked("src/file.py") is True


@pytest.mark.asyncio
async def test_lock_list_locks(db: Database, session_id: str) -> None:
    """Test listing all locks."""
    lock_manager = FileLockManager(db, session_id)

    # Acquire multiple locks
    await lock_manager.acquire("src/file1.py", "agent-1")
    await lock_manager.acquire("src/file2.py", "agent-1")
    await lock_manager.acquire("src/file3.py", "agent-2")

    # List all locks
    all_locks = await lock_manager.list_locks()
    assert len(all_locks) == 3

    # List by agent
    agent1_locks = await lock_manager.list_locks(agent_id="agent-1")
    assert len(agent1_locks) == 2


@pytest.mark.asyncio
async def test_lock_release_all_for_agent(db: Database, session_id: str) -> None:
    """Test releasing all locks for an agent."""
    lock_manager = FileLockManager(db, session_id)

    # Acquire multiple locks
    await lock_manager.acquire("src/file1.py", "agent-1")
    await lock_manager.acquire("src/file2.py", "agent-1")
    await lock_manager.acquire("src/file3.py", "agent-2")

    # Release all for agent-1
    count = await lock_manager.release_all_for_agent("agent-1")
    assert count == 2

    # Verify only agent-2's lock remains
    locks = await lock_manager.list_locks()
    assert len(locks) == 1
    assert locks[0].agent_id == "agent-2"
