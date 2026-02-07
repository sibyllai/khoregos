"""Context storage model for persistent agent context."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ContextEntry(BaseModel):
    """Represents a key-value context entry that persists across sessions."""

    key: str
    session_id: str
    agent_id: str | None = None
    value: Any
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        import json

        return {
            "key": self.key,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "value": json.dumps(self.value),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "ContextEntry":
        """Create context entry from database row."""
        import json

        return cls(
            key=row["key"],
            session_id=row["session_id"],
            agent_id=row["agent_id"],
            value=json.loads(row["value"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


class FileLock(BaseModel):
    """Represents a file lock held by an agent."""

    path: str
    session_id: str
    agent_id: str
    acquired_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime | None = None

    @property
    def is_expired(self) -> bool:
        """Check if lock has expired."""
        if self.expires_at is None:
            return False
        return datetime.utcnow() > self.expires_at

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        return {
            "path": self.path,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "acquired_at": self.acquired_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "FileLock":
        """Create file lock from database row."""
        return cls(
            path=row["path"],
            session_id=row["session_id"],
            agent_id=row["agent_id"],
            acquired_at=datetime.fromisoformat(row["acquired_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]) if row["expires_at"] else None,
        )


class BoundaryViolation(BaseModel):
    """Represents a boundary violation by an agent."""

    id: str
    session_id: str
    agent_id: str | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    file_path: str
    violation_type: str  # "forbidden_path" | "outside_allowed" | "resource_limit"
    enforcement_action: str  # "logged" | "reverted" | "blocked"
    details: dict[str, Any] = Field(default_factory=dict)

    def to_db_row(self) -> dict[str, Any]:
        """Convert to database row format."""
        import json

        return {
            "id": self.id,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "timestamp": self.timestamp.isoformat(),
            "file_path": self.file_path,
            "violation_type": self.violation_type,
            "enforcement_action": self.enforcement_action,
            "details": json.dumps(self.details) if self.details else None,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "BoundaryViolation":
        """Create violation from database row."""
        import json

        return cls(
            id=row["id"],
            session_id=row["session_id"],
            agent_id=row["agent_id"],
            timestamp=datetime.fromisoformat(row["timestamp"]),
            file_path=row["file_path"],
            violation_type=row["violation_type"],
            enforcement_action=row["enforcement_action"],
            details=json.loads(row["details"]) if row["details"] else {},
        )
