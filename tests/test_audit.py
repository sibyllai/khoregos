"""Tests for the audit logger."""

import pytest

from k6s.engine.audit import AuditLogger
from k6s.models.audit import EventType
from k6s.store.db import Database


@pytest.mark.asyncio
async def test_audit_log_event(db: Database, session_id: str) -> None:
    """Test logging an audit event."""
    # Create session first (foreign key constraint)
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    logger = AuditLogger(db, session_id)
    await logger.start()

    try:
        event = await logger.log(
            event_type=EventType.LOG,
            action="Test action",
            details={"key": "value"},
        )

        assert event.id is not None
        assert event.session_id == session_id
        assert event.action == "Test action"
        assert event.sequence == 1
    finally:
        await logger.stop()


@pytest.mark.asyncio
async def test_audit_log_sequence(db: Database, session_id: str) -> None:
    """Test that sequence numbers increment."""
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    logger = AuditLogger(db, session_id)
    await logger.start()

    try:
        event1 = await logger.log(EventType.LOG, "Action 1")
        event2 = await logger.log(EventType.LOG, "Action 2")
        event3 = await logger.log(EventType.LOG, "Action 3")

        assert event1.sequence == 1
        assert event2.sequence == 2
        assert event3.sequence == 3
    finally:
        await logger.stop()


@pytest.mark.asyncio
async def test_audit_log_file_change(db: Database, session_id: str) -> None:
    """Test logging file change events."""
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    logger = AuditLogger(db, session_id)
    await logger.start()

    try:
        event = await logger.log_file_change(
            event_type=EventType.FILE_CREATE,
            file_path="src/new_file.py",
        )

        assert event.event_type == EventType.FILE_CREATE
        assert "src/new_file.py" in event.files_affected
    finally:
        await logger.stop()


@pytest.mark.asyncio
async def test_audit_get_events(db: Database, session_id: str) -> None:
    """Test retrieving audit events."""
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    logger = AuditLogger(db, session_id)
    await logger.start()

    try:
        # Log some events
        await logger.log(EventType.LOG, "Action 1")
        await logger.log(EventType.FILE_CREATE, "Created file")
        await logger.log(EventType.LOG, "Action 2")
        await logger.stop()

        # Retrieve events
        events = await logger.get_events(limit=10)
        assert len(events) == 3

        # Events should be in reverse order (most recent first)
        assert events[0].sequence == 3
        assert events[2].sequence == 1
    finally:
        pass  # Already stopped


@pytest.mark.asyncio
async def test_audit_filter_by_type(db: Database, session_id: str) -> None:
    """Test filtering events by type."""
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    logger = AuditLogger(db, session_id)
    await logger.start()

    try:
        await logger.log(EventType.LOG, "Log 1")
        await logger.log(EventType.FILE_CREATE, "Create 1")
        await logger.log(EventType.LOG, "Log 2")
        await logger.log(EventType.FILE_MODIFY, "Modify 1")
        await logger.stop()

        # Filter by type
        log_events = await logger.get_events(event_type=EventType.LOG)
        assert len(log_events) == 2

        file_events = await logger.get_events(event_type=EventType.FILE_CREATE)
        assert len(file_events) == 1
    finally:
        pass
