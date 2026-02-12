/**
 * In-process event bus for component communication.
 *
 * Uses Node's EventEmitter — much simpler than the Python async queue version.
 */

import { EventEmitter } from "node:events";
import type { AuditEvent, EventType } from "../models/audit.js";

export type EventHandler = (event: AuditEvent) => void;

export class EventBus {
  private emitter = new EventEmitter();

  subscribe(eventType: EventType | "*", handler: EventHandler): void {
    this.emitter.on(eventType, handler);
  }

  unsubscribe(eventType: EventType | "*", handler: EventHandler): void {
    this.emitter.off(eventType, handler);
  }

  publish(event: AuditEvent): void {
    this.emitter.emit(event.eventType, event);
    this.emitter.emit("*", event);
  }
}

let _eventBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!_eventBus) _eventBus = new EventBus();
  return _eventBus;
}

export function resetEventBus(): void {
  _eventBus = null;
}
