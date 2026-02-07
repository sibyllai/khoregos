"""Boundary enforcer for agent file access control."""

import fnmatch
from pathlib import Path
from typing import Any

from ulid import ULID

from k6s.models.config import BoundaryConfig
from k6s.models.context import BoundaryViolation
from k6s.store.db import Database


class BoundaryEnforcer:
    """Prevent agents from modifying files outside their allowed scope.

    Two enforcement levels:
    - Advisory (default): Log violation, continue
    - Strict: Log violation, revert change via git checkout, alert operator
    """

    def __init__(
        self,
        db: Database,
        session_id: str,
        project_root: Path,
        boundaries: list[BoundaryConfig],
    ):
        self.db = db
        self.session_id = session_id
        self.project_root = project_root
        self.boundaries = boundaries

    def get_boundary_for_agent(self, agent_name: str) -> BoundaryConfig | None:
        """Get the boundary configuration that matches an agent name."""
        for boundary in self.boundaries:
            if fnmatch.fnmatch(agent_name, boundary.pattern):
                return boundary

        # Check for wildcard default
        for boundary in self.boundaries:
            if boundary.pattern == "*":
                return boundary

        return None

    def check_path_allowed(
        self,
        file_path: str | Path,
        agent_name: str,
    ) -> tuple[bool, str | None]:
        """Check if an agent is allowed to access a file path.

        Args:
            file_path: The path to check (relative to project root or absolute).
            agent_name: The name of the agent requesting access.

        Returns:
            Tuple of (is_allowed, reason_if_denied).
        """
        boundary = self.get_boundary_for_agent(agent_name)
        if boundary is None:
            # No boundary configured, allow by default
            return True, None

        # Normalize path to be relative to project root
        path = Path(file_path)
        if path.is_absolute():
            try:
                path = path.relative_to(self.project_root)
            except ValueError:
                # Path is outside project root
                return False, f"Path {file_path} is outside project root"

        path_str = str(path)

        # Check forbidden paths first (they take precedence)
        for pattern in boundary.forbidden_paths:
            if fnmatch.fnmatch(path_str, pattern):
                return False, f"Path matches forbidden pattern: {pattern}"

        # If allowed_paths is specified, path must match at least one
        if boundary.allowed_paths:
            for pattern in boundary.allowed_paths:
                if fnmatch.fnmatch(path_str, pattern):
                    return True, None
            return False, f"Path does not match any allowed patterns for {agent_name}"

        # No allowed_paths specified, allow if not forbidden
        return True, None

    async def record_violation(
        self,
        file_path: str,
        agent_id: str | None,
        violation_type: str,
        enforcement_action: str,
        details: dict[str, Any] | None = None,
    ) -> BoundaryViolation:
        """Record a boundary violation in the database.

        Args:
            file_path: The path that was violated.
            agent_id: The agent that caused the violation.
            violation_type: Type of violation (forbidden_path, outside_allowed, resource_limit).
            enforcement_action: Action taken (logged, reverted, blocked).
            details: Additional information about the violation.

        Returns:
            The recorded BoundaryViolation.
        """
        violation = BoundaryViolation(
            id=str(ULID()),
            session_id=self.session_id,
            agent_id=agent_id,
            file_path=file_path,
            violation_type=violation_type,
            enforcement_action=enforcement_action,
            details=details or {},
        )

        await self.db.insert("boundary_violations", violation.to_db_row())
        return violation

    async def get_violations(
        self,
        agent_id: str | None = None,
        limit: int = 100,
    ) -> list[BoundaryViolation]:
        """Get boundary violations for this session.

        Args:
            agent_id: Filter by specific agent (optional).
            limit: Maximum number of violations to return.

        Returns:
            List of BoundaryViolation objects.
        """
        if agent_id:
            sql = """
                SELECT * FROM boundary_violations
                WHERE session_id = ? AND agent_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            """
            params = (self.session_id, agent_id, limit)
        else:
            sql = """
                SELECT * FROM boundary_violations
                WHERE session_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            """
            params = (self.session_id, limit)

        rows = await self.db.fetch_all(sql, params)
        return [BoundaryViolation.from_db_row(row) for row in rows]

    def get_agent_boundaries_summary(self, agent_name: str) -> dict[str, Any]:
        """Get a summary of boundaries for an agent (for MCP tool response)."""
        boundary = self.get_boundary_for_agent(agent_name)
        if boundary is None:
            return {
                "agent": agent_name,
                "has_boundary": False,
                "allowed_paths": [],
                "forbidden_paths": [],
                "enforcement": "none",
            }

        return {
            "agent": agent_name,
            "has_boundary": True,
            "allowed_paths": boundary.allowed_paths,
            "forbidden_paths": boundary.forbidden_paths,
            "enforcement": boundary.enforcement,
            "max_tokens_per_hour": boundary.max_tokens_per_hour,
            "max_cost_per_hour": boundary.max_cost_per_hour,
        }
