"""Claude Code hook handlers.

These commands are invoked automatically by Claude Code hooks
(registered in .claude/settings.json) on every tool call,
subagent spawn/stop, and session stop. They provide non-cooperative
audit logging — agents don't need to voluntarily call MCP tools.

Each handler reads JSON from stdin (piped by Claude Code),
extracts relevant fields, and writes an audit event to SQLite.
"""

import asyncio
import json
import sys
from pathlib import Path

import typer

from k6s.daemon.manager import DaemonState
from k6s.models.audit import EventType
from k6s.store.db import Database

app = typer.Typer(hidden=True)


def _read_hook_input() -> dict:
    """Read and parse JSON from stdin (piped by Claude Code)."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return {}


def _get_session_id(project_root: Path) -> str | None:
    """Get the active session ID from daemon state."""
    daemon_state = DaemonState(project_root / ".khoregos")
    if not daemon_state.is_running():
        return None
    state = daemon_state.read_state()
    return state.get("session_id")


def _log_event(
    project_root: Path,
    session_id: str,
    event_type: EventType,
    action: str,
    details: dict | None = None,
    agent_id: str | None = None,
    files_affected: list[str] | None = None,
) -> None:
    """Write an audit event directly to the database.

    Uses synchronous insert since hook handlers are short-lived
    processes — no need for the async buffered AuditLogger.
    """
    from k6s.engine.audit import AuditLogger

    async def _write() -> None:
        db = Database(project_root / ".khoregos" / "k6s.db")
        await db.connect()
        try:
            logger = AuditLogger(db, session_id)
            await logger.start()
            await logger.log(
                event_type=event_type,
                action=action,
                agent_id=agent_id,
                details=details or {},
                files_affected=files_affected or [],
            )
            await logger.stop()
        finally:
            await db.close()

    asyncio.run(_write())


@app.command(name="post-tool-use")
def post_tool_use() -> None:
    """Handle PostToolUse hook — log every tool call to the audit trail."""
    project_root = Path.cwd()
    session_id = _get_session_id(project_root)
    if not session_id:
        return

    data = _read_hook_input()
    if not data:
        return

    tool_name = data.get("tool_name", "unknown")
    tool_input = data.get("tool_input", {})

    # Extract files affected from common tool patterns
    files_affected = []
    if isinstance(tool_input, dict):
        for key in ("file_path", "path", "filename"):
            if key in tool_input:
                files_affected.append(str(tool_input[key]))

    # Build a readable action summary
    action = f"tool_use: {tool_name}"
    if tool_name == "Bash" and isinstance(tool_input, dict):
        cmd = tool_input.get("command", "")
        action = f"tool_use: bash — {cmd[:120]}"
    elif tool_name in ("Edit", "Write") and files_affected:
        action = f"tool_use: {tool_name.lower()} — {files_affected[0]}"

    _log_event(
        project_root=project_root,
        session_id=session_id,
        event_type=EventType.TOOL_USE,
        action=action,
        details={
            "tool_name": tool_name,
            "tool_input": _truncate(tool_input, max_len=2000),
            "session_id": data.get("session_id"),
            "tool_use_id": data.get("tool_use_id"),
        },
        files_affected=files_affected,
    )


@app.command(name="subagent-start")
def subagent_start() -> None:
    """Handle SubagentStart hook — log agent spawns."""
    project_root = Path.cwd()
    session_id = _get_session_id(project_root)
    if not session_id:
        return

    data = _read_hook_input()
    if not data:
        return

    _log_event(
        project_root=project_root,
        session_id=session_id,
        event_type=EventType.AGENT_SPAWN,
        action=f"agent spawned: {data.get('tool_name', 'subagent')}",
        details={
            "tool_name": data.get("tool_name"),
            "tool_input": _truncate(data.get("tool_input", {}), max_len=2000),
            "session_id": data.get("session_id"),
        },
    )


@app.command(name="subagent-stop")
def subagent_stop() -> None:
    """Handle SubagentStop hook — log agent completions."""
    project_root = Path.cwd()
    session_id = _get_session_id(project_root)
    if not session_id:
        return

    data = _read_hook_input()
    if not data:
        return

    _log_event(
        project_root=project_root,
        session_id=session_id,
        event_type=EventType.AGENT_COMPLETE,
        action=f"agent completed: {data.get('tool_name', 'subagent')}",
        details={
            "tool_name": data.get("tool_name"),
            "session_id": data.get("session_id"),
        },
    )


@app.command(name="session-stop")
def session_stop() -> None:
    """Handle Stop hook — log session end and mark session completed."""
    project_root = Path.cwd()
    session_id = _get_session_id(project_root)
    if not session_id:
        return

    data = _read_hook_input()

    _log_event(
        project_root=project_root,
        session_id=session_id,
        event_type=EventType.SESSION_COMPLETE,
        action="claude code session ended",
        details={
            "session_id": data.get("session_id") if data else None,
        },
    )

    # Mark session as completed in the database
    async def _complete_session() -> None:
        from k6s.engine.state import StateManager

        db = Database(project_root / ".khoregos" / "k6s.db")
        await db.connect()
        try:
            state_manager = StateManager(db, project_root)
            await state_manager.mark_session_completed(session_id)
        finally:
            await db.close()

    asyncio.run(_complete_session())

    # Remove daemon state file so `is_running()` returns False
    daemon_state = DaemonState(project_root / ".khoregos")
    daemon_state.remove_state()


def _truncate(obj: object, max_len: int = 2000) -> object:
    """Truncate large values to keep audit records reasonable."""
    s = json.dumps(obj) if not isinstance(obj, str) else obj
    if len(s) > max_len:
        return s[:max_len] + "...[truncated]"
    return obj
