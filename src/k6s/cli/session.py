"""Session management CLI commands."""

import asyncio
import json
from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from k6s.models.session import Session
from k6s.store.db import Database

app = typer.Typer()
console = Console()


@app.command(name="list")
def list_sessions(
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum sessions to show"),
    all_states: bool = typer.Option(False, "--all", "-a", help="Show all states"),
) -> None:
    """List all sessions."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[dim]No sessions found.[/dim]")
        return

    async def get_sessions() -> list[Session]:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)
            return await state_manager.list_sessions(limit=limit)
        finally:
            await db.close()

    sessions = asyncio.run(get_sessions())

    if not sessions:
        console.print("[dim]No sessions found.[/dim]")
        return

    table = Table(title="Sessions")
    table.add_column("ID", style="cyan")
    table.add_column("Objective")
    table.add_column("State")
    table.add_column("Started")
    table.add_column("Duration")
    table.add_column("Cost")
    table.add_column("Tokens")

    for session in sessions:
        duration = ""
        if session.duration_seconds:
            hours = int(session.duration_seconds // 3600)
            minutes = int((session.duration_seconds % 3600) // 60)
            duration = f"{hours}h {minutes}m" if hours else f"{minutes}m"

        state_style = {
            "completed": "green",
            "active": "yellow",
            "created": "yellow",
            "paused": "blue",
            "failed": "red",
        }.get(session.state.value, "white")

        tokens = ""
        if session.total_input_tokens or session.total_output_tokens:
            tokens = f"{session.total_input_tokens + session.total_output_tokens:,}"

        table.add_row(
            session.id[:8] + "...",
            session.objective[:35] + ("..." if len(session.objective) > 35 else ""),
            f"[{state_style}]{session.state.value}[/{state_style}]",
            session.started_at.strftime("%Y-%m-%d %H:%M"),
            duration or "-",
            f"${session.total_cost_usd:.2f}" if session.total_cost_usd else "-",
            tokens or "-",
        )

    console.print(table)


@app.command(name="latest")
def latest_session() -> None:
    """Show the most recent session (shortcut for `session show latest`)."""
    show_session("latest")


@app.command(name="show")
def show_session(
    session_id: str = typer.Argument(..., help="Session ID (or prefix). Use 'latest' for most recent."),
) -> None:
    """Show detailed session information."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No sessions found.[/yellow]")
        return

    async def get_session_details() -> dict | None:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            from k6s.engine.audit import AuditLogger

            state_manager = StateManager(db, project_root)

            # Find session: "latest" = most recent, otherwise match by ID or prefix
            sessions = await state_manager.list_sessions(limit=100)
            session = None
            if session_id.lower() == "latest" and sessions:
                session = sessions[0]
            else:
                for s in sessions:
                    if s.id.startswith(session_id) or s.id == session_id:
                        session = s
                        break

            if not session:
                return None

            # Get agents
            agents = await state_manager.list_agents(session.id)

            # Get audit event count
            audit_logger = AuditLogger(db, session.id)
            event_count = await audit_logger.get_event_count()

            # Get context entries
            context = await state_manager.load_all_context(session.id)

            return {
                "session": session,
                "agents": agents,
                "event_count": event_count,
                "context": context,
            }
        finally:
            await db.close()

    data = asyncio.run(get_session_details())

    if not data:
        console.print(f"[red]Session not found: {session_id}[/red]")
        raise typer.Exit(1)

    session = data["session"]
    agents = data["agents"]
    event_count = data["event_count"]
    context = data["context"]

    # Session info
    console.print(Panel(
        f"[bold]ID:[/bold] {session.id}\n"
        f"[bold]Objective:[/bold] {session.objective}\n"
        f"[bold]State:[/bold] {session.state.value}\n"
        f"[bold]Started:[/bold] {session.started_at.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"[bold]Ended:[/bold] {session.ended_at.strftime('%Y-%m-%d %H:%M:%S') if session.ended_at else '-'}\n"
        f"[bold]Parent:[/bold] {session.parent_session_id[:8] + '...' if session.parent_session_id else '-'}\n"
        f"[bold]Cost:[/bold] ${session.total_cost_usd:.4f}\n"
        f"[bold]Tokens:[/bold] {session.total_input_tokens:,} in / {session.total_output_tokens:,} out\n"
        f"[bold]Audit Events:[/bold] {event_count:,}",
        title="Session Details",
    ))

    # Agents
    if agents:
        console.print()
        console.print("[bold]Agents:[/bold]")
        for agent in agents:
            spec = f" ({agent.specialization})" if agent.specialization else ""
            console.print(f"  [cyan]{agent.name}[/cyan]{spec} - {agent.role.value}, {agent.state.value}")

    # Context summary
    if context:
        console.print()
        console.print("[bold]Saved Context:[/bold]")
        for entry in context[:10]:
            value_str = str(entry.value)
            if len(value_str) > 60:
                value_str = value_str[:60] + "..."
            console.print(f"  [dim]{entry.key}:[/dim] {value_str}")

    # Session summary
    if session.context_summary:
        console.print()
        console.print(Panel(session.context_summary, title="Session Summary"))


@app.command()
def context(
    session_id: str = typer.Argument(..., help="Session ID (or prefix). Use 'latest' for most recent."),
    key: str = typer.Option(None, "--key", "-k", help="Specific context key to show"),
    format: str = typer.Option("text", "--format", "-f", help="Output format: text, json"),
) -> None:
    """View saved context for a session."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No sessions found.[/yellow]")
        return

    async def get_context() -> list:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            # Find session: "latest" = most recent, otherwise match by ID or prefix
            sessions = await state_manager.list_sessions(limit=100)
            session = None
            if session_id.lower() == "latest" and sessions:
                session = sessions[0]
            else:
                for s in sessions:
                    if s.id.startswith(session_id) or s.id == session_id:
                        session = s
                        break

            if not session:
                return []

            if key:
                entry = await state_manager.load_context(session.id, key)
                return [entry] if entry else []
            else:
                return await state_manager.load_all_context(session.id)
        finally:
            await db.close()

    entries = asyncio.run(get_context())

    if not entries:
        if key:
            console.print(f"[yellow]Context key not found: {key}[/yellow]")
        else:
            console.print("[dim]No context saved for this session.[/dim]")
        return

    if format == "json":
        data = [{"key": e.key, "value": e.value, "updated_at": e.updated_at.isoformat()} for e in entries]
        print(json.dumps(data, indent=2))
    else:
        for entry in entries:
            console.print(f"[bold cyan]{entry.key}[/bold cyan]")
            console.print(f"[dim]Updated: {entry.updated_at.strftime('%Y-%m-%d %H:%M:%S')}[/dim]")
            console.print()

            if isinstance(entry.value, dict):
                console.print(json.dumps(entry.value, indent=2))
            else:
                console.print(str(entry.value))
            console.print()


@app.command()
def delete(
    session_id: str = typer.Argument(..., help="Session ID to delete"),
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation"),
) -> None:
    """Delete a session and all its data."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No sessions found.[/yellow]")
        return

    async def get_session() -> Session | None:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            sessions = await state_manager.list_sessions(limit=100)
            for s in sessions:
                if s.id.startswith(session_id) or s.id == session_id:
                    return s
            return None
        finally:
            await db.close()

    session = asyncio.run(get_session())

    if not session:
        console.print(f"[red]Session not found: {session_id}[/red]")
        raise typer.Exit(1)

    if not force:
        console.print(f"[yellow]Delete session {session.id[:8]}...?[/yellow]")
        console.print(f"Objective: {session.objective}")
        confirm = typer.confirm("Are you sure?")
        if not confirm:
            console.print("[dim]Cancelled.[/dim]")
            raise typer.Exit(0)

    async def delete_session() -> None:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            # Delete related records first (foreign key constraints)
            await db.delete("audit_events", "session_id = ?", (session.id,))
            await db.delete("agents", "session_id = ?", (session.id,))
            await db.delete("context_store", "session_id = ?", (session.id,))
            await db.delete("file_locks", "session_id = ?", (session.id,))
            await db.delete("boundary_violations", "session_id = ?", (session.id,))
            await db.delete("gates", "session_id = ?", (session.id,))
            await db.delete("cost_records", "session_id = ?", (session.id,))
            await db.delete("sessions", "id = ?", (session.id,))
        finally:
            await db.close()

    asyncio.run(delete_session())
    console.print(f"[green]✓[/green] Session {session.id[:8]}... deleted")
