"""Audit trail CLI commands."""

import asyncio
from datetime import datetime, timedelta
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from k6s.models.audit import AuditEvent, EventType
from k6s.store.db import Database

app = typer.Typer()
console = Console()


@app.command(name="show")
def show(
    session: str = typer.Option(
        "latest", "--session", "-s", help="Session ID or 'latest'"
    ),
    agent: str = typer.Option(None, "--agent", "-a", help="Filter by agent name"),
    event_type: str = typer.Option(None, "--type", "-t", help="Filter by event type"),
    since: str = typer.Option(None, "--since", help="Show events since (e.g., '1h', '30m')"),
    limit: int = typer.Option(50, "--limit", "-n", help="Maximum events to show"),
) -> None:
    """Show audit trail events."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No audit data found.[/yellow]")
        return

    async def get_events() -> tuple[list[AuditEvent], str]:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            # Resolve session ID
            if session == "latest":
                from k6s.engine.state import StateManager
                state_manager = StateManager(db, project_root)
                latest = await state_manager.get_latest_session()
                if not latest:
                    return [], ""
                session_id = latest.id
            else:
                session_id = session

            from k6s.engine.audit import AuditLogger
            audit_logger = AuditLogger(db, session_id)

            # Parse since parameter
            since_dt = None
            if since:
                since_dt = _parse_duration(since)

            # Parse event type
            evt_type = None
            if event_type:
                try:
                    evt_type = EventType(event_type)
                except ValueError:
                    pass

            events = await audit_logger.get_events(
                limit=limit,
                event_type=evt_type,
                since=since_dt,
            )
            return events, session_id
        finally:
            await db.close()

    events, session_id = asyncio.run(get_events())

    if not events:
        console.print("[dim]No events found.[/dim]")
        return

    console.print(f"[bold]Session:[/bold] {session_id[:8]}...")
    console.print()

    table = Table()
    table.add_column("Time", style="dim")
    table.add_column("Seq", style="dim")
    table.add_column("Agent", style="cyan")
    table.add_column("Type", style="yellow")
    table.add_column("Action")

    for event in events:
        agent_name = event.agent_id[:8] + "..." if event.agent_id else "system"
        table.add_row(
            event.timestamp.strftime("%H:%M:%S"),
            str(event.sequence),
            agent_name,
            event.event_type.value,
            event.action[:50] + ("..." if len(event.action) > 50 else ""),
        )

    console.print(table)


@app.command()
def tail(
    session: str = typer.Option(
        "latest", "--session", "-s", help="Session ID or 'latest'"
    ),
    follow: bool = typer.Option(True, "--follow", "-f", help="Follow new events"),
) -> None:
    """Live stream audit events."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No audit data found.[/yellow]")
        return

    console.print("[dim]Streaming audit events (Ctrl+C to stop)...[/dim]")
    console.print()

    last_sequence = 0

    async def stream() -> None:
        nonlocal last_sequence
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            # Resolve session ID
            if session == "latest":
                from k6s.engine.state import StateManager
                state_manager = StateManager(db, project_root)
                latest = await state_manager.get_latest_session()
                if not latest:
                    console.print("[yellow]No session found.[/yellow]")
                    return
                session_id = latest.id
            else:
                session_id = session

            from k6s.engine.audit import AuditLogger
            audit_logger = AuditLogger(db, session_id)

            # Show recent events first
            events = await audit_logger.get_events(limit=10)
            for event in reversed(events):
                _print_event(event)
                last_sequence = max(last_sequence, event.sequence)

            if not follow:
                return

            # Poll for new events
            while True:
                await asyncio.sleep(1)
                events = await audit_logger.get_events(limit=100)
                new_events = [e for e in events if e.sequence > last_sequence]
                for event in reversed(new_events):
                    _print_event(event)
                    last_sequence = max(last_sequence, event.sequence)
        finally:
            await db.close()

    try:
        asyncio.run(stream())
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped.[/dim]")


@app.command(name="export")
def export_audit(
    session: str = typer.Option(
        "latest", "--session", "-s", help="Session ID or 'latest'"
    ),
    format: str = typer.Option(
        "json", "--format", "-f", help="Output format: json, csv"
    ),
    output: str = typer.Option(None, "--output", "-o", help="Output file (stdout if not specified)"),
) -> None:
    """Export audit trail."""
    import json
    import csv
    import sys
    from io import StringIO

    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"

    if not (khoregos_dir / "k6s.db").exists():
        console.print("[yellow]No audit data found.[/yellow]", file=sys.stderr)
        return

    async def get_all_events() -> list[AuditEvent]:
        db = Database(khoregos_dir / "k6s.db")
        await db.connect()
        try:
            if session == "latest":
                from k6s.engine.state import StateManager
                state_manager = StateManager(db, project_root)
                latest = await state_manager.get_latest_session()
                if not latest:
                    return []
                session_id = latest.id
            else:
                session_id = session

            from k6s.engine.audit import AuditLogger
            audit_logger = AuditLogger(db, session_id)
            return await audit_logger.get_events(limit=10000)
        finally:
            await db.close()

    events = asyncio.run(get_all_events())

    if format == "json":
        data = [e.model_dump() for e in events]
        output_str = json.dumps(data, indent=2, default=str)
    elif format == "csv":
        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["timestamp", "sequence", "session_id", "agent_id", "event_type", "action", "files_affected"])
        for event in events:
            writer.writerow([
                event.timestamp.isoformat(),
                event.sequence,
                event.session_id,
                event.agent_id or "",
                event.event_type.value,
                event.action,
                ";".join(event.files_affected),
            ])
        output_str = buffer.getvalue()
    else:
        console.print(f"[red]Unknown format: {format}[/red]", file=sys.stderr)
        raise typer.Exit(1)

    if output:
        Path(output).write_text(output_str)
        console.print(f"[green]✓[/green] Exported {len(events)} events to {output}")
    else:
        print(output_str)


def _print_event(event: AuditEvent) -> None:
    """Print a single audit event to console."""
    agent = event.agent_id[:8] if event.agent_id else "system"
    type_color = {
        "file_create": "green",
        "file_modify": "yellow",
        "file_delete": "red",
        "session_start": "blue",
        "session_complete": "blue",
    }.get(event.event_type.value, "white")

    console.print(
        f"[dim]{event.timestamp.strftime('%H:%M:%S')}[/dim] "
        f"[cyan]{agent:>10}[/cyan] "
        f"[{type_color}]{event.event_type.value:15}[/{type_color}] "
        f"{event.action}"
    )


def _parse_duration(duration: str) -> datetime:
    """Parse a duration string like '1h' or '30m' to a datetime."""
    now = datetime.utcnow()
    value = int(duration[:-1])
    unit = duration[-1]

    if unit == "h":
        return now - timedelta(hours=value)
    elif unit == "m":
        return now - timedelta(minutes=value)
    elif unit == "d":
        return now - timedelta(days=value)
    else:
        raise ValueError(f"Unknown duration unit: {unit}")
