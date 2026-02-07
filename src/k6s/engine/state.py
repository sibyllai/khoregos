"""State manager for persisting session state."""

from datetime import datetime
from pathlib import Path
from typing import Any

from k6s.models.agent import Agent
from k6s.models.context import ContextEntry
from k6s.models.session import Session, SessionState
from k6s.store.db import Database


class StateManager:
    """Persist session state so work survives restarts.

    Sessions are first-class entities with lifecycle:
    CREATED → ACTIVE → PAUSED → COMPLETED
    """

    def __init__(self, db: Database, project_root: Path):
        self.db = db
        self.project_root = project_root

    # Session management

    async def create_session(
        self,
        objective: str,
        config_snapshot: dict[str, Any] | None = None,
        parent_session_id: str | None = None,
    ) -> Session:
        """Create a new session."""
        session = Session(
            objective=objective,
            config_snapshot=config_snapshot,
            parent_session_id=parent_session_id,
        )
        await self.db.insert("sessions", session.to_db_row())
        return session

    async def get_session(self, session_id: str) -> Session | None:
        """Get a session by ID."""
        row = await self.db.fetch_one(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        )
        if row is None:
            return None
        return Session.from_db_row(row)

    async def get_latest_session(self) -> Session | None:
        """Get the most recent session."""
        row = await self.db.fetch_one(
            "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1"
        )
        if row is None:
            return None
        return Session.from_db_row(row)

    async def get_active_session(self) -> Session | None:
        """Get the currently active session (if any)."""
        row = await self.db.fetch_one(
            "SELECT * FROM sessions WHERE state IN ('created', 'active') ORDER BY started_at DESC LIMIT 1"
        )
        if row is None:
            return None
        return Session.from_db_row(row)

    async def list_sessions(
        self,
        limit: int = 20,
        offset: int = 0,
        state: SessionState | None = None,
    ) -> list[Session]:
        """List sessions with optional filtering."""
        if state:
            sql = """
                SELECT * FROM sessions
                WHERE state = ?
                ORDER BY started_at DESC
                LIMIT ? OFFSET ?
            """
            params = (state.value, limit, offset)
        else:
            sql = """
                SELECT * FROM sessions
                ORDER BY started_at DESC
                LIMIT ? OFFSET ?
            """
            params = (limit, offset)

        rows = await self.db.fetch_all(sql, params)
        return [Session.from_db_row(row) for row in rows]

    async def update_session(self, session: Session) -> None:
        """Update a session."""
        await self.db.update(
            "sessions",
            session.to_db_row(),
            "id = ?",
            (session.id,),
        )

    async def mark_session_active(self, session_id: str) -> None:
        """Mark a session as active."""
        await self.db.update(
            "sessions",
            {"state": SessionState.ACTIVE.value},
            "id = ?",
            (session_id,),
        )

    async def mark_session_paused(self, session_id: str) -> None:
        """Mark a session as paused."""
        await self.db.update(
            "sessions",
            {"state": SessionState.PAUSED.value},
            "id = ?",
            (session_id,),
        )

    async def mark_session_completed(
        self, session_id: str, summary: str | None = None
    ) -> None:
        """Mark a session as completed."""
        data: dict[str, Any] = {
            "state": SessionState.COMPLETED.value,
            "ended_at": datetime.utcnow().isoformat(),
        }
        if summary:
            data["context_summary"] = summary
        await self.db.update("sessions", data, "id = ?", (session_id,))

    # Agent management

    async def register_agent(
        self,
        session_id: str,
        name: str,
        role: str = "teammate",
        specialization: str | None = None,
        boundary_config: dict[str, Any] | None = None,
    ) -> Agent:
        """Register a new agent in a session."""
        agent = Agent(
            session_id=session_id,
            name=name,
            role=role,
            specialization=specialization,
            boundary_config=boundary_config,
        )
        await self.db.insert("agents", agent.to_db_row())
        return agent

    async def get_agent(self, agent_id: str) -> Agent | None:
        """Get an agent by ID."""
        row = await self.db.fetch_one(
            "SELECT * FROM agents WHERE id = ?", (agent_id,)
        )
        if row is None:
            return None
        return Agent.from_db_row(row)

    async def get_agent_by_name(
        self, session_id: str, name: str
    ) -> Agent | None:
        """Get an agent by name within a session."""
        row = await self.db.fetch_one(
            "SELECT * FROM agents WHERE session_id = ? AND name = ?",
            (session_id, name),
        )
        if row is None:
            return None
        return Agent.from_db_row(row)

    async def list_agents(self, session_id: str) -> list[Agent]:
        """List all agents in a session."""
        rows = await self.db.fetch_all(
            "SELECT * FROM agents WHERE session_id = ? ORDER BY spawned_at",
            (session_id,),
        )
        return [Agent.from_db_row(row) for row in rows]

    async def update_agent(self, agent: Agent) -> None:
        """Update an agent."""
        await self.db.update(
            "agents",
            agent.to_db_row(),
            "id = ?",
            (agent.id,),
        )

    # Context management

    async def save_context(
        self,
        session_id: str,
        key: str,
        value: Any,
        agent_id: str | None = None,
    ) -> ContextEntry:
        """Save a context entry."""
        entry = ContextEntry(
            key=key,
            session_id=session_id,
            agent_id=agent_id,
            value=value,
        )
        await self.db.insert_or_replace("context_store", entry.to_db_row())
        return entry

    async def load_context(
        self,
        session_id: str,
        key: str,
    ) -> ContextEntry | None:
        """Load a context entry."""
        row = await self.db.fetch_one(
            "SELECT * FROM context_store WHERE session_id = ? AND key = ?",
            (session_id, key),
        )
        if row is None:
            return None
        return ContextEntry.from_db_row(row)

    async def load_all_context(
        self,
        session_id: str,
        agent_id: str | None = None,
    ) -> list[ContextEntry]:
        """Load all context entries for a session."""
        if agent_id:
            sql = """
                SELECT * FROM context_store
                WHERE session_id = ? AND agent_id = ?
                ORDER BY key
            """
            params = (session_id, agent_id)
        else:
            sql = """
                SELECT * FROM context_store
                WHERE session_id = ?
                ORDER BY key
            """
            params = (session_id,)

        rows = await self.db.fetch_all(sql, params)
        return [ContextEntry.from_db_row(row) for row in rows]

    async def delete_context(self, session_id: str, key: str) -> None:
        """Delete a context entry."""
        await self.db.delete(
            "context_store",
            "session_id = ? AND key = ?",
            (session_id, key),
        )

    # Session summary for resumption

    async def generate_resume_context(self, session_id: str) -> str:
        """Generate context summary for resuming a session.

        This creates a markdown summary of:
        - The session objective
        - Agents that were active
        - Key context entries
        - Recent activity summary
        """
        session = await self.get_session(session_id)
        if session is None:
            return ""

        agents = await self.list_agents(session_id)
        context_entries = await self.load_all_context(session_id)

        # Build markdown summary
        lines = [
            "## Previous Session Context",
            "",
            f"**Objective**: {session.objective}",
            f"**Started**: {session.started_at.strftime('%Y-%m-%d %H:%M')}",
            "",
        ]

        if session.context_summary:
            lines.extend([
                "### Session Summary",
                session.context_summary,
                "",
            ])

        if agents:
            lines.extend([
                "### Active Agents",
            ])
            for agent in agents:
                spec = f" ({agent.specialization})" if agent.specialization else ""
                lines.append(f"- **{agent.name}**{spec}: {agent.state.value}")
            lines.append("")

        if context_entries:
            lines.extend([
                "### Saved Context",
            ])
            for entry in context_entries[:10]:  # Limit to 10 most relevant
                value_preview = str(entry.value)[:100]
                if len(str(entry.value)) > 100:
                    value_preview += "..."
                lines.append(f"- **{entry.key}**: {value_preview}")
            lines.append("")

        return "\n".join(lines)
