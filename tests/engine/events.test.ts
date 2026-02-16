/**
 * Tests for EventBus: subscribe, publish, unsubscribe.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../src/engine/events.js";
import type { AuditEvent } from "../../src/models/audit.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("publish invokes handler subscribed to event type", () => {
    const received: AuditEvent[] = [];
    bus.subscribe("tool_use", (event) => received.push(event));
    const event: AuditEvent = {
      id: "01",
      timestamp: new Date().toISOString(),
      sequence: 1,
      sessionId: "s1",
      agentId: null,
      eventType: "tool_use",
      action: "read",
      details: null,
      filesAffected: null,
      gateId: null,
      hmac: null,
      severity: "info",
    };
    bus.publish(event);
    expect(received).toHaveLength(1);
    expect(received[0].eventType).toBe("tool_use");
    expect(received[0].action).toBe("read");
  });

  it("publish invokes wildcard handler", () => {
    const received: AuditEvent[] = [];
    bus.subscribe("*", (e) => received.push(e));
    const event: AuditEvent = {
      id: "01",
      timestamp: new Date().toISOString(),
      sequence: 1,
      sessionId: "s1",
      agentId: null,
      eventType: "session_start",
      action: "start",
      details: null,
      filesAffected: null,
      gateId: null,
      hmac: null,
      severity: "info",
    };
    bus.publish(event);
    expect(received).toHaveLength(1);
    expect(received[0].eventType).toBe("session_start");
  });

  it("unsubscribe stops handler from being invoked", () => {
    const received: AuditEvent[] = [];
    const handler = (e: AuditEvent) => received.push(e);
    bus.subscribe("tool_use", handler);
    bus.unsubscribe("tool_use", handler);
    const event: AuditEvent = {
      id: "01",
      timestamp: new Date().toISOString(),
      sequence: 1,
      sessionId: "s1",
      agentId: null,
      eventType: "tool_use",
      action: "run",
      details: null,
      filesAffected: null,
      gateId: null,
      hmac: null,
      severity: "info",
    };
    bus.publish(event);
    expect(received).toHaveLength(0);
  });
});
