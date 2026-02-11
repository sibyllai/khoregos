"""Team management CLI commands."""

import asyncio
import os
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from k6s.daemon.manager import (
    DaemonState,
    inject_claude_md_governance,
    register_hooks,
    register_mcp_server,
    remove_claude_md_governance,
    unregister_hooks,
)
from k6s.models.config import K6sConfig
from k6s.models.session import Session, SessionState
from k6s.store.db import Database

app = typer.Typer()
console = Console()


def _escape_for_shell(s: str) -> str:
    """Escape a string for safe use in shell command display."""
    # Replace newlines with spaces, escape single quotes
    return s.replace("\n", " ").replace("'", "'\\''")


@app.command()
def start(
    objective: str = typer.Argument(..., help="What the team will work on"),
    run: bool = typer.Option(
        False, "--run", "-r", help="Launch Claude Code with the objective as prompt"
    ),
) -> None:
    """Start an agent team session with governance.

    Sets up governance (CLAUDE.md, MCP server) and creates a session.
    Use --run to automatically launch Claude Code with the objective.
    Run `k6s team stop` when done.
    """
    project_root = Path.cwd()
    config_file = project_root / "k6s.yaml"
    khoregos_dir = project_root / ".khoregos"

    # Check initialization
    if not config_file.exists():
        console.print("[red]Not initialized.[/red] Run [bold]k6s init[/bold] first.")
        raise typer.Exit(1)

    # Check if already running
    daemon_state = DaemonState(khoregos_dir)
    if daemon_state.is_running():
        state = daemon_state.read_state()
        session_id = state.get("session_id", "unknown")
        console.print(f"[yellow]Session {session_id[:8]}... is already active.[/yellow]")
        console.print()
        console.print("Continue working with: [bold cyan]claude[/bold cyan]")
        console.print("Or stop first with:    [bold]k6s team stop[/bold]")
        raise typer.Exit(1)

    # Load config
    config = K6sConfig.load(config_file)

    async def setup_session() -> Session:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            # Create session
            session = await state_manager.create_session(
                objective=objective,
                config_snapshot=config.model_dump(),
            )

            # Mark as active
            await state_manager.mark_session_active(session.id)

            return session
        finally:
            await db.close()

    # Create session
    session = asyncio.run(setup_session())

    console.print(f"[green]✓[/green] Session [bold]{session.id[:8]}...[/bold] created")

    # Inject CLAUDE.md governance
    inject_claude_md_governance(project_root, session.id)
    console.print("[green]✓[/green] CLAUDE.md updated with governance rules")

    # Register MCP server and hooks
    register_mcp_server(project_root)
    register_hooks(project_root)
    console.print("[green]✓[/green] MCP server and hooks registered")

    # Write session state (marks session as active)
    daemon_state.write_state({"session_id": session.id})

    # Normalize objective for display (collapse newlines)
    objective_oneline = " ".join(objective.split())

    console.print()
    console.print(f"[bold]Objective:[/bold] {objective_oneline}")
    console.print()

    if run:
        console.print("[bold]Launching Claude Code...[/bold]")
        console.print()

        # Flush all output before execvp replaces this process
        sys.stdout.flush()
        sys.stderr.flush()

        # Launch Claude Code with the objective as the initial prompt
        try:
            # Pass objective directly as argument (not -p which is print mode)
            os.execvp("claude", ["claude", objective])
        except FileNotFoundError:
            console.print("[red]Claude Code not found.[/red]")
            console.print("Make sure 'claude' is in your PATH.")
            raise typer.Exit(1)
    else:
        escaped = _escape_for_shell(objective_oneline)
        console.print("[green]Session ready![/green] Now run:")
        console.print()
        console.print(f"  [bold cyan]claude '{escaped}'[/bold cyan]")
        console.print()
        console.print("When done, run [bold]k6s team stop[/bold] to end the session.")


@app.command()
def stop() -> None:
    """Stop the current agent team session."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    daemon_state = DaemonState(khoregos_dir)

    if not daemon_state.is_running():
        console.print("[yellow]No active session.[/yellow]")
        raise typer.Exit(1)

    # Get session info
    state = daemon_state.read_state()
    session_id = state.get("session_id", "unknown")

    # Mark session as completed
    async def complete_session() -> None:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)
            await state_manager.mark_session_completed(session_id)
        finally:
            await db.close()

    asyncio.run(complete_session())

    # Cleanup
    remove_claude_md_governance(project_root)
    unregister_hooks(project_root)
    daemon_state.remove_state()

    console.print(f"[green]✓[/green] Session {session_id[:8]}... stopped")
    console.print("[green]✓[/green] Governance removed (CLAUDE.md, hooks)")


@app.command()
def resume(
    session_id: str = typer.Argument(
        None, help="Session ID to resume (defaults to latest session)"
    ),
) -> None:
    """Resume a previous session.

    Creates a new session linked to the previous one, with context preserved.
    Then run `claude` to continue working.
    """
    project_root = Path.cwd()
    config_file = project_root / "k6s.yaml"
    khoregos_dir = project_root / ".khoregos"

    if not config_file.exists():
        console.print("[red]Not initialized.[/red]")
        raise typer.Exit(1)

    daemon_state = DaemonState(khoregos_dir)
    if daemon_state.is_running():
        state = daemon_state.read_state()
        sid = state.get("session_id", "unknown")
        console.print(f"[yellow]Session {sid[:8]}... is already active.[/yellow]")
        console.print()
        console.print("Continue working with: [bold cyan]claude[/bold cyan]")
        console.print("Or stop first with:    [bold]k6s team stop[/bold]")
        raise typer.Exit(1)

    async def get_session_to_resume() -> Session | None:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            if session_id:
                return await state_manager.get_session(session_id)
            else:
                # Get latest session
                sessions = await state_manager.list_sessions(limit=1)
                return sessions[0] if sessions else None
        finally:
            await db.close()

    session = asyncio.run(get_session_to_resume())

    if session is None:
        console.print("[yellow]No session found to resume.[/yellow]")
        raise typer.Exit(1)

    console.print(f"[green]✓[/green] Resuming from session [bold]{session.id[:8]}...[/bold]")
    console.print(f"[bold]Objective:[/bold] {session.objective}")

    # Generate resume context and start new session
    async def resume_session() -> Session:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            # Generate context from previous session
            context = await state_manager.generate_resume_context(session.id)

            # Create new session linked to previous
            config = K6sConfig.load(config_file)
            new_session = await state_manager.create_session(
                objective=session.objective,
                config_snapshot=config.model_dump(),
                parent_session_id=session.id,
            )

            # Save resume context
            await state_manager.save_context(
                new_session.id,
                "resume_context",
                context,
            )

            await state_manager.mark_session_active(new_session.id)
            return new_session
        finally:
            await db.close()

    new_session = asyncio.run(resume_session())

    # Inject CLAUDE.md with resume context
    inject_claude_md_governance(project_root, new_session.id)
    register_mcp_server(project_root)
    register_hooks(project_root)
    daemon_state.write_state({"session_id": new_session.id})

    console.print(f"[green]✓[/green] New session [bold]{new_session.id[:8]}...[/bold] created")
    console.print("[green]✓[/green] Previous context injected into CLAUDE.md")
    console.print()
    console.print("[green]Session ready![/green] Now run:")
    console.print()
    console.print("  [bold cyan]claude[/bold cyan]")
    console.print()
    console.print("When done, run [bold]k6s team stop[/bold] to end the session.")


@app.command(name="status")
def team_status() -> None:
    """Show current team session status."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    daemon_state = DaemonState(khoregos_dir)

    if not daemon_state.is_running():
        console.print("[dim]No active session[/dim]")
        return

    state = daemon_state.read_state()
    session_id = state.get("session_id", "unknown")

    async def get_status() -> dict:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            from k6s.engine.state import StateManager
            state_manager = StateManager(db, project_root)

            session = await state_manager.get_session(session_id)
            agents = await state_manager.list_agents(session_id) if session else []

            return {
                "session": session,
                "agents": agents,
            }
        finally:
            await db.close()

    data = asyncio.run(get_status())
    session = data["session"]
    agents = data["agents"]

    if session:
        console.print(f"[bold]Session:[/bold] {session.id[:8]}...")
        console.print(f"[bold]Objective:[/bold] {session.objective}")
        console.print(f"[bold]State:[/bold] {session.state.value}")
        console.print(f"[bold]Started:[/bold] {session.started_at.strftime('%Y-%m-%d %H:%M')}")

        if agents:
            console.print()
            console.print("[bold]Agents:[/bold]")
            for agent in agents:
                console.print(f"  - {agent.name} ({agent.role.value}): {agent.state.value}")


@app.command()
def history(
    limit: int = typer.Option(10, "--limit", "-n", help="Number of sessions to show"),
) -> None:
    """List past sessions."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No sessions found.[/yellow]")
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

    table = Table(title="Session History")
    table.add_column("ID", style="cyan")
    table.add_column("Objective")
    table.add_column("State")
    table.add_column("Started")
    table.add_column("Cost")

    for session in sessions:
        state_style = {
            SessionState.COMPLETED: "green",
            SessionState.ACTIVE: "yellow",
            SessionState.PAUSED: "blue",
            SessionState.FAILED: "red",
        }.get(session.state, "dim")

        table.add_row(
            session.id[:8] + "...",
            session.objective[:40] + ("..." if len(session.objective) > 40 else ""),
            f"[{state_style}]{session.state.value}[/{state_style}]",
            session.started_at.strftime("%Y-%m-%d %H:%M"),
            f"${session.total_cost_usd:.2f}" if session.total_cost_usd else "-",
        )

    console.print(table)
