"""Main CLI entry point for Khoregos."""

import asyncio
from pathlib import Path

import typer
from rich.console import Console

from k6s import __version__
from k6s.cli.audit import app as audit_app
from k6s.cli.session import app as session_app
from k6s.cli.team import app as team_app
from k6s.models.config import generate_default_config

app = typer.Typer(
    name="k6s",
    help="Khoregos: Enterprise governance layer for Claude Code Agent Teams",
    no_args_is_help=True,
)

console = Console()

# Add subcommands
app.add_typer(team_app, name="team", help="Manage agent team sessions")
app.add_typer(audit_app, name="audit", help="View audit trail")
app.add_typer(session_app, name="session", help="Manage sessions")


@app.command()
def init(
    project_name: str = typer.Option(
        None, "--name", "-n", help="Project name (defaults to directory name)"
    ),
    force: bool = typer.Option(
        False, "--force", "-f", help="Overwrite existing configuration"
    ),
) -> None:
    """Initialize Khoregos in the current project."""
    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"
    config_file = project_root / "k6s.yaml"

    # Check if already initialized
    if config_file.exists() and not force:
        console.print(
            "[yellow]Project already initialized.[/yellow] "
            "Use --force to overwrite."
        )
        raise typer.Exit(1)

    # Determine project name
    if project_name is None:
        project_name = project_root.name

    # Create .khoregos directory
    khoregos_dir.mkdir(exist_ok=True)
    console.print(f"[green]✓[/green] Created {khoregos_dir.relative_to(project_root)}/")

    # Create config file
    config = generate_default_config(project_name)
    config.save(config_file)
    console.print(f"[green]✓[/green] Created {config_file.name}")

    # Create .gitignore for .khoregos
    gitignore = khoregos_dir / ".gitignore"
    gitignore.write_text("# Ignore database and daemon state\n*.db\n*.db-*\ndaemon.*\n")
    console.print(f"[green]✓[/green] Created {gitignore.relative_to(project_root)}")

    console.print()
    console.print(f"[bold green]Khoregos initialized for {project_name}[/bold green]")
    console.print()
    console.print("Next steps:")
    console.print("  1. Edit k6s.yaml to configure boundaries and gates")
    console.print('  2. Run [bold]k6s team start "your objective"[/bold] to begin a session')


@app.command()
def version() -> None:
    """Show version information."""
    console.print(f"Khoregos v{__version__}")


@app.command()
def status() -> None:
    """Show current Khoregos status."""
    from k6s.daemon.manager import DaemonState

    project_root = Path.cwd()
    khoregos_dir = project_root / ".khoregos"
    config_file = project_root / "k6s.yaml"

    # Check initialization
    if not config_file.exists():
        console.print("[yellow]Not initialized.[/yellow] Run [bold]k6s init[/bold] first.")
        raise typer.Exit(1)

    console.print(f"[bold]Project:[/bold] {project_root.name}")
    console.print(f"[bold]Config:[/bold] {config_file}")

    # Check daemon status
    daemon_state = DaemonState(khoregos_dir)
    if daemon_state.is_running():
        state = daemon_state.read_state()
        session_id = state.get("session_id", "unknown")
        console.print(f"[bold]Status:[/bold] [green]Active[/green]")
        console.print(f"[bold]Session:[/bold] {session_id}")
    else:
        console.print(f"[bold]Status:[/bold] [dim]Inactive[/dim]")


@app.command(name="mcp")
def mcp_command(
    action: str = typer.Argument(..., help="Action: serve"),
) -> None:
    """MCP server commands."""
    if action == "serve":
        _run_mcp_server()
    else:
        console.print(f"[red]Unknown action: {action}[/red]")
        raise typer.Exit(1)


def _run_mcp_server() -> None:
    """Run the MCP server (called by Claude Code)."""
    import os
    from k6s.mcp.server import K6sServer
    from k6s.models.config import K6sConfig
    from k6s.store.db import Database

    project_root = Path.cwd()
    config_file = project_root / "k6s.yaml"

    # Load config
    if config_file.exists():
        config = K6sConfig.load(config_file)
    else:
        config = generate_default_config(project_root.name)

    # Get session ID from environment or daemon state
    session_id = os.environ.get("K6S_SESSION_ID")
    if not session_id:
        from k6s.daemon.manager import DaemonState
        daemon_state = DaemonState(project_root / ".khoregos")
        state = daemon_state.read_state()
        session_id = state.get("session_id", "default")

    async def run() -> None:
        db = Database(project_root / ".khoregos" / "k6s.db")
        await db.connect()
        try:
            server = K6sServer(db, config, session_id, project_root)
            await server.run_stdio()
        finally:
            await db.close()

    asyncio.run(run())


def main() -> None:
    """Main entry point."""
    app()


if __name__ == "__main__":
    main()
