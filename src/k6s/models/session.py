"""Session model for tracking agent team sessions."""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field
from ulid import ULID


class SessionState(str, Enum):
    """Session lifecycle states."""

    CREATED = "created"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


class Session(BaseModel):
    """Represents an agent team session."""

    id: str = Field(default_factory=lambda: str(ULID()))
    objective: str
    state: SessionState = SessionState.CREATED
    started_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: datetime | None = None
    parent_session_id: str | None = None
    config_snapshot: dict[str, Any] | None = None
    context_summary: str | None = None
    total_cost_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)

    def mark_active(self) -> None:
        """Transition session to active state."""
        self.state = SessionState.ACTIVE

    def mark_paused(self) -> None:
        """Transition session to paused state."""
        self.state = SessionState.PAUSED

    def mark_completed(self, summary: str | None = None) -> None:
        """Transition session to completed state."""
        self.state = SessionState.COMPLETED
        self.ended_at = datetime.utcnow()
        if summary:
            self.context_summary = summary

    def mark_failed(self, reason: str | None = None) -> None:
        """Transition session to failed state."""
        self.state = SessionState.FAILED
        self.ended_at = datetime.utcnow()
        if reason:
            self.metadata["failure_reason"] = reason

    def add_cost(self, input_tokens: int, output_tokens: int, cost_usd: float) -> None:
        """Add token usage and cost to session totals."""
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_cost_usd += cost_usd

    @property
    def duration_seconds(self) -> float | None:
        """Calculate session duration in seconds."""
        if self.ended_at:
            return (self.ended_at - self.started_at).total_seconds()
        return None

    @property
    def is_active(self) -> bool:
        """Check if session is in an active state."""
        return self.state in (SessionState.CREATED, SessionState.ACTIVE)

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        return {
            "id": self.id,
            "objective": self.objective,
            "state": self.state.value,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "parent_session_id": self.parent_session_id,
            "config_snapshot": self.model_dump_json() if self.config_snapshot else None,
            "context_summary": self.context_summary,
            "total_cost_usd": self.total_cost_usd,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "metadata": self.model_dump_json() if self.metadata else None,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "Session":
        """Create session from database row."""
        import json

        return cls(
            id=row["id"],
            objective=row["objective"],
            state=SessionState(row["state"]),
            started_at=datetime.fromisoformat(row["started_at"]),
            ended_at=datetime.fromisoformat(row["ended_at"]) if row["ended_at"] else None,
            parent_session_id=row["parent_session_id"],
            config_snapshot=json.loads(row["config_snapshot"]) if row["config_snapshot"] else None,
            context_summary=row["context_summary"],
            total_cost_usd=row["total_cost_usd"] or 0.0,
            total_input_tokens=row["total_input_tokens"] or 0,
            total_output_tokens=row["total_output_tokens"] or 0,
            metadata=json.loads(row["metadata"]) if row["metadata"] else {},
        )
