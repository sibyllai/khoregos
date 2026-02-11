"""Tests for the SQLite store."""

import pytest

from k6s.store.db import Database


@pytest.mark.asyncio
async def test_database_connection(db: Database) -> None:
    """Test database connects and creates tables."""
    # Verify tables exist
    result = await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    )
    assert result is not None
    assert result["name"] == "sessions"


@pytest.mark.asyncio
async def test_database_insert_and_fetch(db: Database) -> None:
    """Test basic insert and fetch operations."""
    # Insert a session
    await db.insert("sessions", {
        "id": "test-session-1",
        "objective": "Test objective",
        "state": "created",
        "started_at": "2024-01-01T00:00:00",
    })

    # Fetch it back
    result = await db.fetch_one(
        "SELECT * FROM sessions WHERE id = ?", ("test-session-1",)
    )
    assert result is not None
    assert result["objective"] == "Test objective"


@pytest.mark.asyncio
async def test_database_update(db: Database) -> None:
    """Test update operations."""
    # Insert a session
    await db.insert("sessions", {
        "id": "test-session-2",
        "objective": "Original objective",
        "state": "created",
        "started_at": "2024-01-01T00:00:00",
    })

    # Update it
    rows_affected = await db.update(
        "sessions",
        {"objective": "Updated objective"},
        "id = ?",
        ("test-session-2",),
    )
    assert rows_affected == 1

    # Verify update
    result = await db.fetch_one(
        "SELECT * FROM sessions WHERE id = ?", ("test-session-2",)
    )
    assert result["objective"] == "Updated objective"


@pytest.mark.asyncio
async def test_database_delete(db: Database) -> None:
    """Test delete operations."""
    # Insert a session
    await db.insert("sessions", {
        "id": "test-session-3",
        "objective": "To be deleted",
        "state": "created",
        "started_at": "2024-01-01T00:00:00",
    })

    # Delete it
    rows_deleted = await db.delete("sessions", "id = ?", ("test-session-3",))
    assert rows_deleted == 1

    # Verify deletion
    result = await db.fetch_one(
        "SELECT * FROM sessions WHERE id = ?", ("test-session-3",)
    )
    assert result is None


@pytest.mark.asyncio
async def test_database_fetch_all(db: Database) -> None:
    """Test fetch_all operation."""
    # Insert multiple sessions
    for i in range(3):
        await db.insert("sessions", {
            "id": f"test-session-{i}",
            "objective": f"Objective {i}",
            "state": "created",
            "started_at": "2024-01-01T00:00:00",
        })

    # Fetch all
    results = await db.fetch_all("SELECT * FROM sessions ORDER BY id")
    assert len(results) == 3
    assert results[0]["id"] == "test-session-0"
