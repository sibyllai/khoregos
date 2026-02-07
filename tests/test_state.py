"""Tests for the state manager."""

from pathlib import Path

import pytest

from k6s.engine.state import StateManager
from k6s.models.session import SessionState
from k6s.store.db import Database


@pytest.mark.asyncio
async def test_create_session(db: Database, project_root: Path) -> None:
    """Test creating a session."""
    state_manager = StateManager(db, project_root)

    session = await state_manager.create_session(
        objective="Test objective",
        config_snapshot={"version": "1"},
    )

    assert session.id is not None
    assert session.objective == "Test objective"
    assert session.state == SessionState.CREATED


@pytest.mark.asyncio
async def test_get_session(db: Database, project_root: Path) -> None:
    """Test getting a session by ID."""
    state_manager = StateManager(db, project_root)

    # Create session
    session = await state_manager.create_session(objective="Test")

    # Get it back
    retrieved = await state_manager.get_session(session.id)

    assert retrieved is not None
    assert retrieved.id == session.id
    assert retrieved.objective == "Test"


@pytest.mark.asyncio
async def test_session_lifecycle(db: Database, project_root: Path) -> None:
    """Test session state transitions."""
    state_manager = StateManager(db, project_root)

    session = await state_manager.create_session(objective="Test")
    assert session.state == SessionState.CREATED

    # Mark active
    await state_manager.mark_session_active(session.id)
    session = await state_manager.get_session(session.id)
    assert session.state == SessionState.ACTIVE

    # Mark paused
    await state_manager.mark_session_paused(session.id)
    session = await state_manager.get_session(session.id)
    assert session.state == SessionState.PAUSED

    # Mark completed
    await state_manager.mark_session_completed(session.id, "All done")
    session = await state_manager.get_session(session.id)
    assert session.state == SessionState.COMPLETED
    assert session.context_summary == "All done"


@pytest.mark.asyncio
async def test_register_agent(db: Database, project_root: Path) -> None:
    """Test registering an agent."""
    state_manager = StateManager(db, project_root)

    # Create session first
    session = await state_manager.create_session(objective="Test")

    # Register agent
    agent = await state_manager.register_agent(
        session_id=session.id,
        name="frontend-dev",
        role="teammate",
        specialization="frontend",
    )

    assert agent.id is not None
    assert agent.name == "frontend-dev"
    assert agent.specialization == "frontend"


@pytest.mark.asyncio
async def test_list_agents(db: Database, project_root: Path) -> None:
    """Test listing agents in a session."""
    state_manager = StateManager(db, project_root)

    session = await state_manager.create_session(objective="Test")

    # Register multiple agents
    await state_manager.register_agent(session.id, "lead", role="lead")
    await state_manager.register_agent(session.id, "frontend-dev")
    await state_manager.register_agent(session.id, "backend-dev")

    # List agents
    agents = await state_manager.list_agents(session.id)
    assert len(agents) == 3


@pytest.mark.asyncio
async def test_save_and_load_context(db: Database, project_root: Path) -> None:
    """Test saving and loading context."""
    state_manager = StateManager(db, project_root)

    session = await state_manager.create_session(objective="Test")

    # Save context
    await state_manager.save_context(
        session.id,
        "decision:architecture",
        {"choice": "microservices", "rationale": "Scalability"},
    )

    # Load context
    entry = await state_manager.load_context(session.id, "decision:architecture")

    assert entry is not None
    assert entry.value["choice"] == "microservices"


@pytest.mark.asyncio
async def test_load_all_context(db: Database, project_root: Path) -> None:
    """Test loading all context entries."""
    state_manager = StateManager(db, project_root)

    session = await state_manager.create_session(objective="Test")

    # Save multiple context entries
    await state_manager.save_context(session.id, "key1", "value1")
    await state_manager.save_context(session.id, "key2", "value2")
    await state_manager.save_context(session.id, "key3", "value3")

    # Load all
    entries = await state_manager.load_all_context(session.id)
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_get_active_session(db: Database, project_root: Path) -> None:
    """Test getting the active session."""
    state_manager = StateManager(db, project_root)

    # No active session initially
    active = await state_manager.get_active_session()
    assert active is None

    # Create and activate session
    session = await state_manager.create_session(objective="Test")
    await state_manager.mark_session_active(session.id)

    # Now we have an active session
    active = await state_manager.get_active_session()
    assert active is not None
    assert active.id == session.id


@pytest.mark.asyncio
async def test_list_sessions(db: Database, project_root: Path) -> None:
    """Test listing sessions."""
    state_manager = StateManager(db, project_root)

    # Create multiple sessions
    await state_manager.create_session(objective="Session 1")
    await state_manager.create_session(objective="Session 2")
    await state_manager.create_session(objective="Session 3")

    # List all
    sessions = await state_manager.list_sessions(limit=10)
    assert len(sessions) == 3

    # List with limit
    sessions = await state_manager.list_sessions(limit=2)
    assert len(sessions) == 2


@pytest.mark.asyncio
async def test_generate_resume_context(db: Database, project_root: Path) -> None:
    """Test generating resume context."""
    state_manager = StateManager(db, project_root)

    # Create session with agents and context
    session = await state_manager.create_session(objective="Build auth system")
    await state_manager.register_agent(session.id, "lead", role="lead")
    await state_manager.register_agent(session.id, "auth-dev", specialization="auth")
    await state_manager.save_context(session.id, "progress", "Implemented OAuth")
    await state_manager.mark_session_completed(session.id, "OAuth complete")

    # Generate resume context
    context = await state_manager.generate_resume_context(session.id)

    assert "Build auth system" in context
    assert "lead" in context
    assert "auth-dev" in context
    assert "progress" in context
