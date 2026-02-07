"""Audit logger for recording all significant actions."""

import asyncio
from datetime import datetime
from typing import Any

from ulid import ULID

from k6s.models.audit import AuditEvent, EventType
from k6s.store.db import Database


class AuditLogger:
    """Record every significant action with who, what, why, when.

    Uses write-ahead log pattern: events buffered in memory,
    flushed to SQLite every 100ms or 100 events.
    """

    FLUSH_INTERVAL_MS = 100
    FLUSH_BATCH_SIZE = 100

    def __init__(self, db: Database, session_id: str):
        self.db = db
        self.session_id = session_id
        self._buffer: list[AuditEvent] = []
        self._sequence = 0
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        self._running = False

    async def start(self) -> None:
        """Start the audit logger background flush task."""
        # Load the current max sequence for this session
        result = await self.db.fetch_one(
            "SELECT MAX(sequence) as max_seq FROM audit_events WHERE session_id = ?",
            (self.session_id,),
        )
        self._sequence = (result["max_seq"] or 0) if result else 0

        self._running = True
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def stop(self) -> None:
        """Stop the audit logger and flush remaining events."""
        self._running = False
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        # Final flush
        await self._flush()

    async def log(
        self,
        event_type: EventType,
        action: str,
        agent_id: str | None = None,
        details: dict[str, Any] | None = None,
        files_affected: list[str] | None = None,
        gate_id: str | None = None,
    ) -> AuditEvent:
        """Log an audit event.

        Args:
            event_type: The type of event being logged.
            action: Human-readable description of the action.
            agent_id: The agent that performed the action (if applicable).
            details: Structured payload with additional information.
            files_affected: List of file paths affected by this action.
            gate_id: Associated gate ID if this event triggered/resolved a gate.

        Returns:
            The created AuditEvent.
        """
        async with self._lock:
            self._sequence += 1
            event = AuditEvent(
                id=str(ULID()),
                timestamp=datetime.utcnow(),
                sequence=self._sequence,
                session_id=self.session_id,
                agent_id=agent_id,
                event_type=event_type,
                action=action,
                details=details or {},
                files_affected=files_affected or [],
                gate_id=gate_id,
            )
            self._buffer.append(event)

            # Flush if buffer is full
            if len(self._buffer) >= self.FLUSH_BATCH_SIZE:
                await self._flush()

        return event

    async def _flush_loop(self) -> None:
        """Background task to periodically flush the buffer."""
        while self._running:
            try:
                await asyncio.sleep(self.FLUSH_INTERVAL_MS / 1000)
                await self._flush()
            except asyncio.CancelledError:
                break

    async def _flush(self) -> None:
        """Flush buffered events to the database."""
        async with self._lock:
            if not self._buffer:
                return

            events_to_flush = self._buffer
            self._buffer = []

        # Insert all events in a single transaction
        for event in events_to_flush:
            await self.db.insert("audit_events", event.to_db_row())

    async def get_events(
        self,
        limit: int = 100,
        offset: int = 0,
        event_type: EventType | None = None,
        agent_id: str | None = None,
        since: datetime | None = None,
    ) -> list[AuditEvent]:
        """Query audit events with optional filtering.

        Args:
            limit: Maximum number of events to return.
            offset: Number of events to skip.
            event_type: Filter by event type.
            agent_id: Filter by agent.
            since: Only return events after this timestamp.

        Returns:
            List of matching AuditEvent objects.
        """
        conditions = ["session_id = ?"]
        params: list[Any] = [self.session_id]

        if event_type:
            conditions.append("event_type = ?")
            params.append(event_type.value)

        if agent_id:
            conditions.append("agent_id = ?")
            params.append(agent_id)

        if since:
            conditions.append("timestamp > ?")
            params.append(since.isoformat())

        where_clause = " AND ".join(conditions)
        sql = f"""
            SELECT * FROM audit_events
            WHERE {where_clause}
            ORDER BY sequence DESC
            LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])

        rows = await self.db.fetch_all(sql, tuple(params))
        return [AuditEvent.from_db_row(row) for row in rows]

    async def get_event_count(self) -> int:
        """Get the total number of audit events for this session."""
        result = await self.db.fetch_one(
            "SELECT COUNT(*) as count FROM audit_events WHERE session_id = ?",
            (self.session_id,),
        )
        return result["count"] if result else 0

    async def log_file_change(
        self,
        event_type: EventType,
        file_path: str,
        agent_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> AuditEvent:
        """Convenience method for logging file change events."""
        action = f"{event_type.value.replace('_', ' ').title()}: {file_path}"
        return await self.log(
            event_type=event_type,
            action=action,
            agent_id=agent_id,
            details=details,
            files_affected=[file_path],
        )

    async def log_session_event(
        self,
        event_type: EventType,
        action: str,
        details: dict[str, Any] | None = None,
    ) -> AuditEvent:
        """Convenience method for logging session lifecycle events."""
        return await self.log(
            event_type=event_type,
            action=action,
            details=details,
        )

    async def log_agent_event(
        self,
        event_type: EventType,
        agent_id: str,
        action: str,
        details: dict[str, Any] | None = None,
    ) -> AuditEvent:
        """Convenience method for logging agent lifecycle events."""
        return await self.log(
            event_type=event_type,
            action=action,
            agent_id=agent_id,
            details=details,
        )
