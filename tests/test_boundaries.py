"""Tests for the boundary enforcer."""

from pathlib import Path

import pytest

from k6s.engine.boundaries import BoundaryEnforcer
from k6s.models.config import BoundaryConfig
from k6s.store.db import Database


@pytest.fixture
def boundaries() -> list[BoundaryConfig]:
    """Create test boundary configurations."""
    return [
        BoundaryConfig(
            pattern="frontend-*",
            allowed_paths=["src/frontend/**", "src/shared/**"],
            forbidden_paths=[".env*", "src/backend/**"],
            enforcement="advisory",
        ),
        BoundaryConfig(
            pattern="backend-*",
            allowed_paths=["src/backend/**", "src/shared/**"],
            forbidden_paths=[".env*"],
            enforcement="advisory",
        ),
        BoundaryConfig(
            pattern="*",
            forbidden_paths=[".env*", "**/*.pem", "**/*.key"],
            enforcement="advisory",
        ),
    ]


@pytest.mark.asyncio
async def test_boundary_get_for_agent(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test getting boundary config for an agent."""
    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    # Specific pattern match
    frontend_boundary = enforcer.get_boundary_for_agent("frontend-dev")
    assert frontend_boundary is not None
    assert frontend_boundary.pattern == "frontend-*"

    # Wildcard match
    other_boundary = enforcer.get_boundary_for_agent("some-other-agent")
    assert other_boundary is not None
    assert other_boundary.pattern == "*"


@pytest.mark.asyncio
async def test_boundary_check_allowed_path(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test checking if a path is allowed."""
    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    # Frontend agent can access frontend paths
    allowed, reason = enforcer.check_path_allowed("src/frontend/app.tsx", "frontend-dev")
    assert allowed is True

    # Frontend agent can access shared paths
    allowed, reason = enforcer.check_path_allowed("src/shared/utils.ts", "frontend-dev")
    assert allowed is True

    # Frontend agent cannot access backend paths
    allowed, reason = enforcer.check_path_allowed("src/backend/api.py", "frontend-dev")
    assert allowed is False
    assert "forbidden" in reason.lower()


@pytest.mark.asyncio
async def test_boundary_check_forbidden_path(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test checking forbidden paths."""
    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    # .env files are forbidden for all agents
    allowed, reason = enforcer.check_path_allowed(".env", "frontend-dev")
    assert allowed is False

    allowed, reason = enforcer.check_path_allowed(".env.local", "backend-dev")
    assert allowed is False

    # Sensitive files are forbidden via wildcard
    allowed, reason = enforcer.check_path_allowed("certs/server.pem", "other-agent")
    assert allowed is False


@pytest.mark.asyncio
async def test_boundary_check_outside_allowed(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test paths outside allowed patterns."""
    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    # Frontend agent has allowed_paths, so other paths are forbidden
    allowed, reason = enforcer.check_path_allowed("docs/readme.md", "frontend-dev")
    assert allowed is False
    assert "allowed patterns" in reason.lower()


@pytest.mark.asyncio
async def test_boundary_record_violation(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test recording a boundary violation."""
    # Create session first
    await db.insert("sessions", {
        "id": session_id,
        "objective": "Test",
        "state": "active",
        "started_at": "2024-01-01T00:00:00",
    })

    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    violation = await enforcer.record_violation(
        file_path="src/backend/secrets.py",
        agent_id="agent-123",
        violation_type="forbidden_path",
        enforcement_action="logged",
        details={"reason": "Test violation"},
    )

    assert violation.id is not None
    assert violation.file_path == "src/backend/secrets.py"
    assert violation.violation_type == "forbidden_path"

    # Retrieve violations
    violations = await enforcer.get_violations()
    assert len(violations) == 1
    assert violations[0].id == violation.id


@pytest.mark.asyncio
async def test_boundary_summary(
    db: Database,
    session_id: str,
    project_root: Path,
    boundaries: list[BoundaryConfig],
) -> None:
    """Test getting boundary summary for MCP response."""
    enforcer = BoundaryEnforcer(db, session_id, project_root, boundaries)

    summary = enforcer.get_agent_boundaries_summary("frontend-dev")

    assert summary["agent"] == "frontend-dev"
    assert summary["has_boundary"] is True
    assert "src/frontend/**" in summary["allowed_paths"]
    assert ".env*" in summary["forbidden_paths"]
    assert summary["enforcement"] == "advisory"
