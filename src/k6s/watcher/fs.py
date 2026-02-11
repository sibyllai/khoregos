"""Filesystem watcher for non-cooperative enforcement.

Monitors file changes independently of whether agents use MCP tools.
This is the safety net that catches all file modifications.
"""

import asyncio
import fnmatch
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from watchdog.events import (
    FileCreatedEvent,
    FileDeletedEvent,
    FileModifiedEvent,
    FileMovedEvent,
    FileSystemEvent,
    FileSystemEventHandler,
)
from watchdog.observers import Observer

from k6s.models.audit import EventType


class FileChangeEvent:
    """Represents a file change detected by the watcher."""

    def __init__(
        self,
        event_type: EventType,
        path: str,
        is_directory: bool = False,
        old_path: str | None = None,
    ):
        self.event_type = event_type
        self.path = path
        self.is_directory = is_directory
        self.old_path = old_path  # For move events

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "event_type": self.event_type.value,
            "path": self.path,
            "is_directory": self.is_directory,
            "old_path": self.old_path,
        }


# Callback type for file change events
FileChangeCallback = Callable[[FileChangeEvent], None]


class K6sEventHandler(FileSystemEventHandler):
    """Watchdog event handler that converts events to K6s format."""

    # Default patterns to ignore
    DEFAULT_IGNORE_PATTERNS = [
        ".git/**",
        ".khoregos/**",
        "__pycache__/**",
        "*.pyc",
        ".DS_Store",
        "*.swp",
        "*.swo",
        "*~",
        "node_modules/**",
        ".venv/**",
        "venv/**",
    ]

    def __init__(
        self,
        callback: FileChangeCallback,
        project_root: Path,
        ignore_patterns: list[str] | None = None,
    ):
        super().__init__()
        self.callback = callback
        self.project_root = project_root
        self.ignore_patterns = ignore_patterns or self.DEFAULT_IGNORE_PATTERNS

    def _should_ignore(self, path: str) -> bool:
        """Check if a path should be ignored."""
        try:
            rel_path = Path(path).relative_to(self.project_root)
        except ValueError:
            return True  # Outside project root

        pure = PurePosixPath(str(rel_path))
        for pattern in self.ignore_patterns:
            if pure.match(pattern):
                return True
        return False

    def _get_relative_path(self, path: str) -> str:
        """Get path relative to project root."""
        try:
            return str(Path(path).relative_to(self.project_root))
        except ValueError:
            return path

    def on_created(self, event: FileSystemEvent) -> None:
        """Handle file/directory creation."""
        if self._should_ignore(event.src_path):
            return

        change = FileChangeEvent(
            event_type=EventType.FILE_CREATE,
            path=self._get_relative_path(event.src_path),
            is_directory=event.is_directory,
        )
        self.callback(change)

    def on_modified(self, event: FileSystemEvent) -> None:
        """Handle file modification."""
        if event.is_directory:
            return  # Ignore directory modification events
        if self._should_ignore(event.src_path):
            return

        change = FileChangeEvent(
            event_type=EventType.FILE_MODIFY,
            path=self._get_relative_path(event.src_path),
            is_directory=False,
        )
        self.callback(change)

    def on_deleted(self, event: FileSystemEvent) -> None:
        """Handle file/directory deletion."""
        if self._should_ignore(event.src_path):
            return

        change = FileChangeEvent(
            event_type=EventType.FILE_DELETE,
            path=self._get_relative_path(event.src_path),
            is_directory=event.is_directory,
        )
        self.callback(change)

    def on_moved(self, event: FileSystemEvent) -> None:
        """Handle file/directory move (rename)."""
        if not isinstance(event, FileMovedEvent):
            return
        if self._should_ignore(event.src_path) and self._should_ignore(event.dest_path):
            return

        # Treat as delete + create
        if not self._should_ignore(event.src_path):
            delete_event = FileChangeEvent(
                event_type=EventType.FILE_DELETE,
                path=self._get_relative_path(event.src_path),
                is_directory=event.is_directory,
            )
            self.callback(delete_event)

        if not self._should_ignore(event.dest_path):
            create_event = FileChangeEvent(
                event_type=EventType.FILE_CREATE,
                path=self._get_relative_path(event.dest_path),
                is_directory=event.is_directory,
                old_path=self._get_relative_path(event.src_path),
            )
            self.callback(create_event)


class FilesystemWatcher:
    """Watch for filesystem changes and emit events.

    This provides non-cooperative enforcement: even if agents ignore
    MCP tools, Khoregos still sees what files changed.
    """

    def __init__(
        self,
        project_root: Path,
        ignore_patterns: list[str] | None = None,
    ):
        self.project_root = project_root
        self.ignore_patterns = ignore_patterns
        self._observer: Observer | None = None
        self._callbacks: list[FileChangeCallback] = []
        self._event_queue: asyncio.Queue[FileChangeEvent] = asyncio.Queue()
        self._running = False
        self._process_task: asyncio.Task[None] | None = None

    def on_change(self, callback: FileChangeCallback) -> None:
        """Register a callback for file changes.

        The callback will be called for each file change event.
        """
        self._callbacks.append(callback)

    def _handle_event(self, event: FileChangeEvent) -> None:
        """Handle a file change event from watchdog.

        This runs in the watchdog thread, so we queue the event
        for async processing.
        """
        try:
            # Put event in queue (non-blocking)
            self._event_queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # Drop event if queue is full

    async def _process_events(self) -> None:
        """Process file change events from the queue."""
        while self._running:
            try:
                event = await asyncio.wait_for(
                    self._event_queue.get(), timeout=0.1
                )
                # Call all registered callbacks
                for callback in self._callbacks:
                    try:
                        callback(event)
                    except Exception:
                        pass  # Don't let callback errors stop processing
                self._event_queue.task_done()
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

    def start(self) -> None:
        """Start watching for file changes."""
        if self._observer is not None:
            return  # Already running

        handler = K6sEventHandler(
            callback=self._handle_event,
            project_root=self.project_root,
            ignore_patterns=self.ignore_patterns,
        )

        self._observer = Observer()
        self._observer.schedule(
            handler, str(self.project_root), recursive=True
        )
        self._observer.start()

        self._running = True
        self._process_task = asyncio.create_task(self._process_events())

    async def stop(self) -> None:
        """Stop watching for file changes."""
        self._running = False

        if self._process_task:
            self._process_task.cancel()
            try:
                await self._process_task
            except asyncio.CancelledError:
                pass
            self._process_task = None

        if self._observer:
            self._observer.stop()
            self._observer.join(timeout=5)
            self._observer = None

    @property
    def is_running(self) -> bool:
        """Check if the watcher is running."""
        return self._observer is not None and self._observer.is_alive()


class GatePatternMatcher:
    """Match file paths against gate trigger patterns."""

    # Common dependency file patterns
    DEPENDENCY_PATTERNS = [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "requirements.txt",
        "requirements*.txt",
        "Pipfile",
        "Pipfile.lock",
        "pyproject.toml",
        "poetry.lock",
        "go.mod",
        "go.sum",
        "Cargo.toml",
        "Cargo.lock",
        "**/pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "Gemfile",
        "Gemfile.lock",
    ]

    # Security-sensitive file patterns
    SECURITY_PATTERNS = [
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        "*.crt",
        "*.p12",
        "*.pfx",
        "**/auth/**",
        "**/security/**",
        "**/secrets/**",
        "credentials.json",
        "service-account.json",
    ]

    def __init__(self, patterns: list[str]):
        self.patterns = patterns

    def matches(self, path: str) -> bool:
        """Check if a path matches any of the patterns."""
        pure = PurePosixPath(path)
        for pattern in self.patterns:
            if pure.match(pattern):
                return True
        return False

    @classmethod
    def for_dependencies(cls) -> "GatePatternMatcher":
        """Create a matcher for dependency files."""
        return cls(cls.DEPENDENCY_PATTERNS)

    @classmethod
    def for_security(cls) -> "GatePatternMatcher":
        """Create a matcher for security-sensitive files."""
        return cls(cls.SECURITY_PATTERNS)
