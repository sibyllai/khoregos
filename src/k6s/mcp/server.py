"""MCP server exposing governance tools for Claude Code agents.

This is the primary integration point - agents use MCP tools to
interact with governance: logging actions, checking gates,
requesting locks, saving/loading persistent context.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Resource,
    TextContent,
    Tool,
)

from k6s.engine.audit import AuditLogger
from k6s.engine.boundaries import BoundaryEnforcer
from k6s.engine.locks import FileLockManager
from k6s.engine.state import StateManager
from k6s.models.audit import EventType
from k6s.models.config import K6sConfig
from k6s.store.db import Database


class K6sServer:
    """MCP server providing governance tools for agents."""

    def __init__(
        self,
        db: Database,
        config: K6sConfig,
        session_id: str,
        project_root: Path,
    ):
        self.db = db
        self.config = config
        self.session_id = session_id
        self.project_root = project_root

        # Initialize components
        self.audit_logger = AuditLogger(db, session_id)
        self.state_manager = StateManager(db, project_root)
        self.boundary_enforcer = BoundaryEnforcer(
            db, session_id, project_root, config.boundaries
        )
        self.lock_manager = FileLockManager(db, session_id)

        # Create MCP server
        self.server = Server("khoregos")
        self._register_tools()
        self._register_resources()

    def _register_tools(self) -> None:
        """Register all MCP tools."""

        @self.server.list_tools()
        async def list_tools() -> list[Tool]:
            return [
                Tool(
                    name="k6s_log",
                    description="Log an action to the audit trail. Call this before and after significant actions.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "description": "Human-readable description of the action",
                            },
                            "event_type": {
                                "type": "string",
                                "description": "Type of event (log, file_write, task_update, etc.)",
                                "default": "log",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent performing the action",
                            },
                            "details": {
                                "type": "object",
                                "description": "Additional structured details",
                            },
                            "files": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "List of files affected by this action",
                            },
                        },
                        "required": ["action"],
                    },
                ),
                Tool(
                    name="k6s_save_context",
                    description="Save persistent context that survives session restarts.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Unique key for this context entry",
                            },
                            "value": {
                                "description": "Value to save (any JSON-serializable data)",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent saving context",
                            },
                        },
                        "required": ["key", "value"],
                    },
                ),
                Tool(
                    name="k6s_load_context",
                    description="Load previously saved context.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Key of the context entry to load",
                            },
                        },
                        "required": ["key"],
                    },
                ),
                Tool(
                    name="k6s_acquire_lock",
                    description="Acquire an exclusive lock on a file to prevent conflicts.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to the file to lock",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent requesting the lock",
                            },
                            "duration_seconds": {
                                "type": "integer",
                                "description": "Lock duration in seconds (default: 300)",
                            },
                        },
                        "required": ["path", "agent_name"],
                    },
                ),
                Tool(
                    name="k6s_release_lock",
                    description="Release a file lock.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to the file to unlock",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent releasing the lock",
                            },
                        },
                        "required": ["path", "agent_name"],
                    },
                ),
                Tool(
                    name="k6s_get_boundaries",
                    description="Get the boundary rules for an agent (allowed/forbidden paths).",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent to get boundaries for",
                            },
                        },
                        "required": ["agent_name"],
                    },
                ),
                Tool(
                    name="k6s_check_path",
                    description="Check if an agent is allowed to access a file path.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Path to check",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent",
                            },
                        },
                        "required": ["path", "agent_name"],
                    },
                ),
                Tool(
                    name="k6s_task_update",
                    description="Update task state and progress.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "task_id": {
                                "type": "string",
                                "description": "Unique identifier for the task",
                            },
                            "status": {
                                "type": "string",
                                "description": "Task status (pending, in_progress, completed, failed)",
                            },
                            "progress": {
                                "type": "string",
                                "description": "Progress description",
                            },
                            "agent_name": {
                                "type": "string",
                                "description": "Name of the agent updating the task",
                            },
                        },
                        "required": ["task_id", "status"],
                    },
                ),
            ]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
            try:
                if name == "k6s_log":
                    return await self._handle_log(arguments)
                elif name == "k6s_save_context":
                    return await self._handle_save_context(arguments)
                elif name == "k6s_load_context":
                    return await self._handle_load_context(arguments)
                elif name == "k6s_acquire_lock":
                    return await self._handle_acquire_lock(arguments)
                elif name == "k6s_release_lock":
                    return await self._handle_release_lock(arguments)
                elif name == "k6s_get_boundaries":
                    return await self._handle_get_boundaries(arguments)
                elif name == "k6s_check_path":
                    return await self._handle_check_path(arguments)
                elif name == "k6s_task_update":
                    return await self._handle_task_update(arguments)
                else:
                    return [TextContent(type="text", text=f"Unknown tool: {name}")]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {str(e)}")]

    def _register_resources(self) -> None:
        """Register MCP resources."""

        @self.server.list_resources()
        async def list_resources() -> list[Resource]:
            return [
                Resource(
                    uri="k6s://session/current",
                    name="Current Session",
                    description="Current session metadata",
                    mimeType="application/json",
                ),
                Resource(
                    uri="k6s://audit/recent",
                    name="Recent Audit Events",
                    description="Last 50 audit events",
                    mimeType="application/json",
                ),
                Resource(
                    uri="k6s://boundaries/all",
                    name="Boundary Rules",
                    description="All configured boundary rules",
                    mimeType="application/json",
                ),
            ]

        @self.server.read_resource()
        async def read_resource(uri: str) -> str:
            if uri == "k6s://session/current":
                session = await self.state_manager.get_session(self.session_id)
                if session:
                    return json.dumps(session.model_dump(), default=str)
                return json.dumps({"error": "No active session"})

            elif uri == "k6s://audit/recent":
                events = await self.audit_logger.get_events(limit=50)
                return json.dumps(
                    [e.model_dump() for e in events], default=str
                )

            elif uri == "k6s://boundaries/all":
                return json.dumps(
                    [b.model_dump() for b in self.config.boundaries]
                )

            return json.dumps({"error": f"Unknown resource: {uri}"})

    async def _handle_log(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_log tool call."""
        action = args.get("action", "")
        event_type_str = args.get("event_type", "log")
        agent_name = args.get("agent_name")
        details = args.get("details", {})
        files = args.get("files", [])

        # Map string to EventType
        try:
            event_type = EventType(event_type_str)
        except ValueError:
            event_type = EventType.LOG

        # Get agent ID if agent name provided
        agent_id = None
        if agent_name:
            agent = await self.state_manager.get_agent_by_name(
                self.session_id, agent_name
            )
            if agent:
                agent_id = agent.id

        event = await self.audit_logger.log(
            event_type=event_type,
            action=action,
            agent_id=agent_id,
            details=details,
            files_affected=files,
        )

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "status": "logged",
                    "event_id": event.id,
                    "sequence": event.sequence,
                }),
            )
        ]

    async def _handle_save_context(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_save_context tool call."""
        key = args.get("key", "")
        value = args.get("value")
        agent_name = args.get("agent_name")

        agent_id = None
        if agent_name:
            agent = await self.state_manager.get_agent_by_name(
                self.session_id, agent_name
            )
            if agent:
                agent_id = agent.id

        entry = await self.state_manager.save_context(
            session_id=self.session_id,
            key=key,
            value=value,
            agent_id=agent_id,
        )

        # Log the context save
        await self.audit_logger.log(
            event_type=EventType.CONTEXT_SAVED,
            action=f"Saved context: {key}",
            agent_id=agent_id,
            details={"key": key},
        )

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "status": "saved",
                    "key": key,
                    "updated_at": entry.updated_at.isoformat(),
                }),
            )
        ]

    async def _handle_load_context(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_load_context tool call."""
        key = args.get("key", "")

        entry = await self.state_manager.load_context(self.session_id, key)

        if entry is None:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"status": "not_found", "key": key}),
                )
            ]

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "status": "found",
                    "key": key,
                    "value": entry.value,
                    "updated_at": entry.updated_at.isoformat(),
                }),
            )
        ]

    async def _handle_acquire_lock(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_acquire_lock tool call."""
        path = args.get("path", "")
        agent_name = args.get("agent_name", "unknown")
        duration = args.get("duration_seconds")

        # Get or create agent ID
        agent = await self.state_manager.get_agent_by_name(
            self.session_id, agent_name
        )
        if agent:
            agent_id = agent.id
        else:
            # Register agent if not found
            agent = await self.state_manager.register_agent(
                self.session_id, agent_name
            )
            agent_id = agent.id

        result = await self.lock_manager.acquire(path, agent_id, duration)

        if result.success:
            await self.audit_logger.log(
                event_type=EventType.LOCK_ACQUIRED,
                action=f"Lock acquired: {path}",
                agent_id=agent_id,
                files_affected=[path],
            )

        return [TextContent(type="text", text=json.dumps(result.to_dict()))]

    async def _handle_release_lock(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_release_lock tool call."""
        path = args.get("path", "")
        agent_name = args.get("agent_name", "unknown")

        agent = await self.state_manager.get_agent_by_name(
            self.session_id, agent_name
        )
        agent_id = agent.id if agent else "unknown"

        result = await self.lock_manager.release(path, agent_id)

        if result.success:
            await self.audit_logger.log(
                event_type=EventType.LOCK_RELEASED,
                action=f"Lock released: {path}",
                agent_id=agent_id,
                files_affected=[path],
            )

        return [TextContent(type="text", text=json.dumps(result.to_dict()))]

    async def _handle_get_boundaries(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_get_boundaries tool call."""
        agent_name = args.get("agent_name", "")

        summary = self.boundary_enforcer.get_agent_boundaries_summary(agent_name)
        return [TextContent(type="text", text=json.dumps(summary))]

    async def _handle_check_path(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_check_path tool call."""
        path = args.get("path", "")
        agent_name = args.get("agent_name", "")

        allowed, reason = self.boundary_enforcer.check_path_allowed(path, agent_name)

        result = {
            "path": path,
            "agent": agent_name,
            "allowed": allowed,
        }
        if reason:
            result["reason"] = reason

        return [TextContent(type="text", text=json.dumps(result))]

    async def _handle_task_update(self, args: dict[str, Any]) -> list[TextContent]:
        """Handle k6s_task_update tool call."""
        task_id = args.get("task_id", "")
        status = args.get("status", "")
        progress = args.get("progress", "")
        agent_name = args.get("agent_name")

        agent_id = None
        if agent_name:
            agent = await self.state_manager.get_agent_by_name(
                self.session_id, agent_name
            )
            if agent:
                agent_id = agent.id

        await self.audit_logger.log(
            event_type=EventType.TASK_UPDATE,
            action=f"Task {task_id}: {status}",
            agent_id=agent_id,
            details={
                "task_id": task_id,
                "status": status,
                "progress": progress,
            },
        )

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "status": "updated",
                    "task_id": task_id,
                }),
            )
        ]

    async def start(self) -> None:
        """Start the audit logger."""
        await self.audit_logger.start()

    async def stop(self) -> None:
        """Stop the audit logger."""
        await self.audit_logger.stop()

    async def run_stdio(self) -> None:
        """Run the MCP server using stdio transport."""
        await self.start()
        try:
            async with stdio_server() as (read_stream, write_stream):
                await self.server.run(
                    read_stream,
                    write_stream,
                    self.server.create_initialization_options(),
                )
        finally:
            await self.stop()
