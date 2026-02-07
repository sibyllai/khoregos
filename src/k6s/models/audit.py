"""Audit event model for tracking all significant actions."""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field
from ulid import ULID


class EventType(str, Enum):
    """Types of audit events."""

    # File operations
    FILE_CREATE = "file_create"
    FILE_MODIFY = "file_modify"
    FILE_DELETE = "file_delete"

    # Session lifecycle
    SESSION_START = "session_start"
    SESSION_PAUSE = "session_pause"
    SESSION_RESUME = "session_resume"
    SESSION_COMPLETE = "session_complete"
    SESSION_FAIL = "session_fail"

    # Agent lifecycle
    AGENT_SPAWN = "agent_spawn"
    AGENT_COMPLETE = "agent_complete"
    AGENT_FAIL = "agent_fail"

    # Task tracking
    TASK_CREATE = "task_create"
    TASK_UPDATE = "task_update"
    TASK_COMPLETE = "task_complete"

    # Gate events
    GATE_TRIGGERED = "gate_triggered"
    GATE_APPROVED = "gate_approved"
    GATE_DENIED = "gate_denied"
    GATE_EXPIRED = "gate_expired"

    # Boundary events
    BOUNDARY_VIOLATION = "boundary_violation"
    BOUNDARY_CHECK = "boundary_check"

    # Lock events
    LOCK_ACQUIRED = "lock_acquired"
    LOCK_RELEASED = "lock_released"
    LOCK_DENIED = "lock_denied"

    # Context events
    CONTEXT_SAVED = "context_saved"
    CONTEXT_LOADED = "context_loaded"

    # Cost events
    COST_REPORTED = "cost_reported"
    BUDGET_WARNING = "budget_warning"
    BUDGET_EXCEEDED = "budget_exceeded"

    # Generic
    LOG = "log"
    SYSTEM = "system"


class AuditEvent(BaseModel):
    """Represents a single audit event."""

    id: str = Field(default_factory=lambda: str(ULID()))
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    sequence: int = 0  # Session-scoped monotonic counter
    session_id: str
    agent_id: str | None = None
    event_type: EventType
    action: str  # Human-readable description
    details: dict[str, Any] = Field(default_factory=dict)
    files_affected: list[str] = Field(default_factory=list)
    gate_id: str | None = None
    hmac: str | None = None  # Tamper-evidence signature (Phase 3)

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        import json

        return {
            "id": self.id,
            "sequence": self.sequence,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type.value,
            "action": self.action,
            "details": json.dumps(self.details) if self.details else None,
            "files_affected": json.dumps(self.files_affected) if self.files_affected else None,
            "gate_id": self.gate_id,
            "hmac": self.hmac,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "AuditEvent":
        """Create audit event from database row."""
        import json

        return cls(
            id=row["id"],
            sequence=row["sequence"],
            session_id=row["session_id"],
            agent_id=row["agent_id"],
            timestamp=datetime.fromisoformat(row["timestamp"]),
            event_type=EventType(row["event_type"]),
            action=row["action"],
            details=json.loads(row["details"]) if row["details"] else {},
            files_affected=json.loads(row["files_affected"]) if row["files_affected"] else [],
            gate_id=row["gate_id"],
            hmac=row["hmac"],
        )

    def short_summary(self) -> str:
        """Return a short summary for display."""
        agent_str = f"[{self.agent_id}]" if self.agent_id else "[system]"
        return f"{self.timestamp.strftime('%H:%M:%S')} {agent_str} {self.event_type.value}: {self.action}"
