"""In-process event bus for component communication."""

import asyncio
from collections import defaultdict
from typing import Any, Awaitable, Callable

from k6s.models.audit import AuditEvent

# Type for event handlers
EventHandler = Callable[[AuditEvent], Awaitable[None]]


class EventBus:
    """Simple async pub/sub event bus. No external dependencies."""

    def __init__(self):
        self._subscribers: dict[str, list[EventHandler]] = defaultdict(list)
        self._wildcard_subscribers: list[EventHandler] = []
        self._queue: asyncio.Queue[AuditEvent] = asyncio.Queue()
        self._running = False
        self._task: asyncio.Task[None] | None = None

    def subscribe(self, event_type: str, handler: EventHandler) -> None:
        """Subscribe to events of a specific type.

        Args:
            event_type: The event type to subscribe to, or "*" for all events.
            handler: Async function to call when event is published.
        """
        if event_type == "*":
            self._wildcard_subscribers.append(handler)
        else:
            self._subscribers[event_type].append(handler)

    def unsubscribe(self, event_type: str, handler: EventHandler) -> None:
        """Unsubscribe from events of a specific type."""
        if event_type == "*":
            if handler in self._wildcard_subscribers:
                self._wildcard_subscribers.remove(handler)
        else:
            if handler in self._subscribers[event_type]:
                self._subscribers[event_type].remove(handler)

    async def publish(self, event: AuditEvent) -> None:
        """Publish an event to all subscribers.

        Events are queued and processed asynchronously to avoid blocking.
        """
        await self._queue.put(event)

    async def publish_sync(self, event: AuditEvent) -> None:
        """Publish an event and wait for all handlers to complete.

        Use this when you need to ensure handlers have processed the event
        before continuing.
        """
        await self._dispatch_event(event)

    async def _dispatch_event(self, event: AuditEvent) -> None:
        """Dispatch an event to all matching handlers."""
        handlers: list[EventHandler] = []

        # Add type-specific handlers
        handlers.extend(self._subscribers.get(event.event_type.value, []))

        # Add wildcard handlers
        handlers.extend(self._wildcard_subscribers)

        # Run all handlers concurrently
        if handlers:
            await asyncio.gather(
                *[handler(event) for handler in handlers],
                return_exceptions=True,
            )

    async def _process_queue(self) -> None:
        """Background task to process event queue."""
        while self._running:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=0.1)
                await self._dispatch_event(event)
                self._queue.task_done()
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

    def start(self) -> None:
        """Start the event processing loop."""
        if not self._running:
            self._running = True
            self._task = asyncio.create_task(self._process_queue())

    async def stop(self) -> None:
        """Stop the event processing loop and wait for pending events."""
        self._running = False
        if self._task:
            # Wait for queue to drain
            await self._queue.join()
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    @property
    def pending_count(self) -> int:
        """Return the number of events waiting to be processed."""
        return self._queue.qsize()


# Global event bus instance
_event_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """Get or create the global event bus instance."""
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus


def reset_event_bus() -> None:
    """Reset the global event bus (for testing)."""
    global _event_bus
    _event_bus = None
