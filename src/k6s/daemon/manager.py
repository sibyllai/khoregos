"""Daemon lifecycle management for the K6s governance engine.

The daemon runs as a background process during agent team sessions,
managing the MCP server, filesystem watcher, and event bus.
"""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

from k6s.engine.audit import AuditLogger
from k6s.engine.boundaries import BoundaryEnforcer
from k6s.engine.events import EventBus, get_event_bus
from k6s.engine.locks import FileLockManager
from k6s.engine.state import StateManager
from k6s.models.audit import EventType
from k6s.models.config import K6sConfig
from k6s.store.db import Database, get_database
from k6s.watcher.fs import FileChangeEvent, FilesystemWatcher


class DaemonState:
    """Persistent session state stored in .khoregos/

    Session liveness is determined by the presence of the state file,
    not by PID tracking. The `k6s team start` command is fire-and-forget
    (it sets up governance and exits), so there is no long-running daemon
    process whose PID could be monitored.
    """

    def __init__(self, khoregos_dir: Path):
        self.khoregos_dir = khoregos_dir
        self.state_file = khoregos_dir / "daemon.state"

    def is_running(self) -> bool:
        """Check if a governance session is currently active.

        Uses state file existence — not PID liveness — because
        `k6s team start` is a setup command that exits after
        configuring governance, so no process stays alive to track.
        """
        return self.state_file.exists()

    def write_state(self, state: dict[str, Any]) -> None:
        """Write session state to file, marking the session as active."""
        self.khoregos_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.khoregos_dir, 0o700)
        self.state_file.write_text(json.dumps(state, indent=2))
        os.chmod(self.state_file, 0o600)

    def read_state(self) -> dict[str, Any]:
        """Read session state from file."""
        if not self.state_file.exists():
            return {}
        try:
            return json.loads(self.state_file.read_text())
        except (json.JSONDecodeError, OSError):
            return {}

    def remove_state(self) -> None:
        """Remove the state file, marking the session as inactive."""
        if self.state_file.exists():
            self.state_file.unlink()


class K6sDaemon:
    """The K6s governance daemon.

    Manages:
    - SQLite database connection
    - Filesystem watcher
    - Event bus
    - Audit logging
    - Session state
    """

    def __init__(
        self,
        project_root: Path,
        session_id: str,
        config: K6sConfig,
    ):
        self.project_root = project_root
        self.session_id = session_id
        self.config = config
        self.khoregos_dir = project_root / ".khoregos"

        # State management
        self.daemon_state = DaemonState(self.khoregos_dir)

        # Components (initialized on start)
        self.db: Database | None = None
        self.event_bus: EventBus | None = None
        self.watcher: FilesystemWatcher | None = None
        self.audit_logger: AuditLogger | None = None
        self.state_manager: StateManager | None = None
        self.boundary_enforcer: BoundaryEnforcer | None = None
        self.lock_manager: FileLockManager | None = None

        # Control flags
        self._running = False
        self._shutdown_event: asyncio.Event | None = None

    async def start(self) -> None:
        """Start the daemon and all components."""
        if self.daemon_state.is_running():
            raise RuntimeError("Daemon is already running")

        # Initialize database
        self.db = await get_database(self.project_root)

        # Initialize components
        self.event_bus = get_event_bus()
        self.event_bus.start()

        self.state_manager = StateManager(self.db, self.project_root)
        self.audit_logger = AuditLogger(self.db, self.session_id)
        await self.audit_logger.start()

        self.boundary_enforcer = BoundaryEnforcer(
            self.db,
            self.session_id,
            self.project_root,
            self.config.boundaries,
        )

        self.lock_manager = FileLockManager(self.db, self.session_id)

        # Start filesystem watcher
        self.watcher = FilesystemWatcher(self.project_root)
        self.watcher.on_change(self._handle_file_change)
        self.watcher.start()

        # Log session start
        await self.audit_logger.log(
            event_type=EventType.SESSION_START,
            action=f"Session {self.session_id} started",
            details={"project_root": str(self.project_root)},
        )

        # Update daemon state
        self.daemon_state.write_state({
            "session_id": self.session_id,
            "started_at": asyncio.get_event_loop().time(),
            "project_root": str(self.project_root),
        })

        self._running = True
        self._shutdown_event = asyncio.Event()

        # Set up signal handlers
        for sig in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_event_loop().add_signal_handler(
                sig, lambda: asyncio.create_task(self.stop())
            )

    async def stop(self) -> None:
        """Stop the daemon and all components."""
        if not self._running:
            return

        self._running = False

        # Log session end
        if self.audit_logger:
            await self.audit_logger.log(
                event_type=EventType.SESSION_COMPLETE,
                action=f"Session {self.session_id} stopped",
            )

        # Stop components in reverse order
        if self.watcher:
            await self.watcher.stop()

        if self.lock_manager:
            await self.lock_manager.release_all()

        if self.audit_logger:
            await self.audit_logger.stop()

        if self.event_bus:
            await self.event_bus.stop()

        # Clean up state file
        self.daemon_state.remove_state()

        # Signal shutdown complete
        if self._shutdown_event:
            self._shutdown_event.set()

    async def run(self) -> None:
        """Run the daemon until stopped."""
        await self.start()
        try:
            if self._shutdown_event:
                await self._shutdown_event.wait()
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()

    def _handle_file_change(self, event: FileChangeEvent) -> None:
        """Handle a file change event from the watcher.

        This runs synchronously from the watcher callback, so we
        schedule async work on the event loop.
        """
        asyncio.create_task(self._process_file_change(event))

    async def _process_file_change(self, event: FileChangeEvent) -> None:
        """Process a file change event asynchronously."""
        if not self.audit_logger:
            return

        # Log the file change
        await self.audit_logger.log(
            event_type=event.event_type,
            action=f"{event.event_type.value}: {event.path}",
            files_affected=[event.path],
            details={
                "is_directory": event.is_directory,
                "old_path": event.old_path,
            },
        )

        # Check for boundary violations (attribute to unknown agent for now)
        # TODO: Correlate with MCP context to attribute to specific agent
        if self.boundary_enforcer:
            # Check against default boundary
            allowed, reason = self.boundary_enforcer.check_path_allowed(
                event.path, "*"
            )
            if not allowed:
                await self.boundary_enforcer.record_violation(
                    file_path=event.path,
                    agent_id=None,  # Unknown agent
                    violation_type="forbidden_path",
                    enforcement_action="logged",
                    details={"reason": reason},
                )


def inject_claude_md_governance(project_root: Path, session_id: str) -> None:
    """Inject governance rules into CLAUDE.md.

    This adds a governance section that instructs agents to use
    the K6s MCP tools for logging, gates, and context.
    """
    claude_dir = project_root / ".claude"
    claude_dir.mkdir(exist_ok=True)
    claude_md = claude_dir / "CLAUDE.md"

    governance_section = f"""

## Khoregos Governance (Auto-generated — do not edit)

This project uses Khoregos (k6s) for governance. Session ID: {session_id}

All agents MUST:

1. **Log significant actions** using the `k6s_log` MCP tool before and after:
   - Creating or modifying files
   - Making architectural decisions
   - Completing tasks

2. **Check boundaries** using `k6s_get_boundaries` at session start
   - Only modify files within your allowed paths
   - Never touch forbidden paths
   - Use `k6s_check_path` before modifying any file you're unsure about

3. **Use file locks** via `k6s_acquire_lock` / `k6s_release_lock` when
   editing shared files to prevent conflicts

4. **Save context** using `k6s_save_context` when:
   - Making important decisions (save rationale)
   - Completing major milestones
   - Before ending your session

5. **Load context** using `k6s_load_context` to retrieve previously saved state

<!-- K6S_GOVERNANCE_END -->
"""

    # Read existing content
    existing_content = ""
    if claude_md.exists():
        existing_content = claude_md.read_text()

    # Remove any existing governance section
    if "## Khoregos Governance" in existing_content:
        start = existing_content.find("## Khoregos Governance")
        end = existing_content.find("<!-- K6S_GOVERNANCE_END -->")
        if end != -1:
            end += len("<!-- K6S_GOVERNANCE_END -->")
            existing_content = existing_content[:start] + existing_content[end:]

    # Append new governance section
    new_content = existing_content.rstrip() + governance_section
    claude_md.write_text(new_content)


def remove_claude_md_governance(project_root: Path) -> None:
    """Remove governance rules from CLAUDE.md."""
    claude_md = project_root / ".claude" / "CLAUDE.md"
    if not claude_md.exists():
        return

    content = claude_md.read_text()
    if "## Khoregos Governance" not in content:
        return

    start = content.find("## Khoregos Governance")
    end = content.find("<!-- K6S_GOVERNANCE_END -->")
    if end != -1:
        end += len("<!-- K6S_GOVERNANCE_END -->")
        new_content = content[:start].rstrip() + content[end:]
        claude_md.write_text(new_content)


def register_mcp_server(project_root: Path) -> None:
    """Register the K6s MCP server in Claude Code settings."""
    settings_file = _load_claude_settings(project_root)
    settings = _read_settings(settings_file)

    if "mcpServers" not in settings:
        settings["mcpServers"] = {}

    settings["mcpServers"]["khoregos"] = {
        "command": "k6s",
        "args": ["mcp", "serve"],
    }

    settings_file.write_text(json.dumps(settings, indent=2))


def unregister_mcp_server(project_root: Path) -> None:
    """Remove the K6s MCP server from Claude Code settings."""
    settings_file = project_root / ".claude" / "settings.json"
    if not settings_file.exists():
        return

    try:
        settings = json.loads(settings_file.read_text())
    except json.JSONDecodeError:
        return

    if "mcpServers" in settings and "khoregos" in settings["mcpServers"]:
        del settings["mcpServers"]["khoregos"]
        settings_file.write_text(json.dumps(settings, indent=2))


def register_hooks(project_root: Path) -> None:
    """Register Claude Code hooks for non-cooperative audit logging.

    These hooks fire on every tool call regardless of whether agents
    voluntarily use k6s MCP tools, providing guaranteed audit coverage.
    """
    settings_file = _load_claude_settings(project_root)
    settings = _read_settings(settings_file)

    settings["hooks"] = {
        "PostToolUse": [
            {
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": "k6s hook post-tool-use",
                        "timeout": 10,
                    }
                ],
            }
        ],
        "SubagentStart": [
            {
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": "k6s hook subagent-start",
                        "timeout": 10,
                    }
                ],
            }
        ],
        "SubagentStop": [
            {
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": "k6s hook subagent-stop",
                        "timeout": 10,
                    }
                ],
            }
        ],
        "Stop": [
            {
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": "k6s hook session-stop",
                        "timeout": 10,
                    }
                ],
            }
        ],
    }

    settings_file.write_text(json.dumps(settings, indent=2))


def unregister_hooks(project_root: Path) -> None:
    """Remove Claude Code hooks from project settings."""
    settings_file = project_root / ".claude" / "settings.json"
    if not settings_file.exists():
        return

    try:
        settings = json.loads(settings_file.read_text())
    except json.JSONDecodeError:
        return

    if "hooks" in settings:
        del settings["hooks"]
        settings_file.write_text(json.dumps(settings, indent=2))


def _load_claude_settings(project_root: Path) -> Path:
    """Ensure .claude/ directory exists and return settings.json path."""
    settings_dir = project_root / ".claude"
    settings_dir.mkdir(exist_ok=True)
    return settings_dir / "settings.json"


def _read_settings(settings_file: Path) -> dict[str, Any]:
    """Read settings.json, returning empty dict on missing/corrupt file."""
    if settings_file.exists():
        try:
            return json.loads(settings_file.read_text())
        except json.JSONDecodeError:
            pass
    return {}
