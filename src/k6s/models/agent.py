"""Agent model for tracking individual agents within a session."""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field
from ulid import ULID


class AgentRole(str, Enum):
    """Agent roles within a team."""

    LEAD = "lead"
    TEAMMATE = "teammate"


class AgentState(str, Enum):
    """Agent lifecycle states."""

    ACTIVE = "active"
    IDLE = "idle"
    COMPLETED = "completed"
    FAILED = "failed"


class Agent(BaseModel):
    """Represents an individual agent within a session."""

    id: str = Field(default_factory=lambda: str(ULID()))
    session_id: str
    name: str
    role: AgentRole = AgentRole.TEAMMATE
    specialization: str | None = None
    state: AgentState = AgentState.ACTIVE
    spawned_at: datetime = Field(default_factory=datetime.utcnow)
    boundary_config: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    def mark_idle(self) -> None:
        """Transition agent to idle state."""
        self.state = AgentState.IDLE

    def mark_active(self) -> None:
        """Transition agent to active state."""
        self.state = AgentState.ACTIVE

    def mark_completed(self) -> None:
        """Transition agent to completed state."""
        self.state = AgentState.COMPLETED

    def mark_failed(self, reason: str | None = None) -> None:
        """Transition agent to failed state."""
        self.state = AgentState.FAILED
        if reason:
            self.metadata["failure_reason"] = reason

    @property
    def is_active(self) -> bool:
        """Check if agent is in an active state."""
        return self.state in (AgentState.ACTIVE, AgentState.IDLE)

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        import json

        return {
            "id": self.id,
            "session_id": self.session_id,
            "name": self.name,
            "role": self.role.value,
            "specialization": self.specialization,
            "state": self.state.value,
            "spawned_at": self.spawned_at.isoformat(),
            "boundary_config": json.dumps(self.boundary_config) if self.boundary_config else None,
            "metadata": json.dumps(self.metadata) if self.metadata else None,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "Agent":
        """Create agent from database row."""
        import json

        return cls(
            id=row["id"],
            session_id=row["session_id"],
            name=row["name"],
            role=AgentRole(row["role"]),
            specialization=row["specialization"],
            state=AgentState(row["state"]),
            spawned_at=datetime.fromisoformat(row["spawned_at"]),
            boundary_config=json.loads(row["boundary_config"]) if row["boundary_config"] else None,
            metadata=json.loads(row["metadata"]) if row["metadata"] else {},
        )
