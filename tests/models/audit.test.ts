/**
 * Tests for audit model: schema, toDbRow/fromDbRow, shortSummary.
 */

import { describe, it, expect } from "vitest";
import {
  AuditEventSchema,
  EventType,
  AuditSeverity,
  auditEventToDbRow,
  auditEventFromDbRow,
  shortSummary,
  type AuditEvent,
} from "../../src/models/audit.js";

describe("audit model", () => {
  describe("EventType and AuditSeverity", () => {
    it("EventType accepts valid event types", () => {
      expect(EventType.parse("session_start")).toBe("session_start");
      expect(EventType.parse("tool_use")).toBe("tool_use");
      expect(EventType.parse("gate_triggered")).toBe("gate_triggered");
    });

    it("AuditSeverity accepts info, warning, critical", () => {
      expect(AuditSeverity.parse("info")).toBe("info");
      expect(AuditSeverity.parse("warning")).toBe("warning");
      expect(AuditSeverity.parse("critical")).toBe("critical");
    });
  });

  describe("AuditEventSchema", () => {
    it("parses minimal event with defaults", () => {
      const event = AuditEventSchema.parse({
        sessionId: "s1",
        eventType: "log",
        action: "test",
      });
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.sequence).toBe(0);
      expect(event.severity).toBe("info");
      expect(event.agentId).toBeNull();
      expect(event.details).toBeNull();
      expect(event.filesAffected).toBeNull();
      expect(event.gateId).toBeNull();
      expect(event.hmac).toBeNull();
    });
  });

  describe("auditEventToDbRow and auditEventFromDbRow", () => {
    it("roundtrips event to db row and back", () => {
      const event: AuditEvent = {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        sessionId: "s1",
        agentId: "a1",
        eventType: "tool_use",
        action: "read_file",
        details: '{"trace_id":"t1"}',
        filesAffected: '["src/a.ts"]',
        gateId: null,
        hmac: "abc123",
        severity: "warning",
      };
      const row = auditEventToDbRow(event);
      expect(row.session_id).toBe(event.sessionId);
      expect(row.event_type).toBe(event.eventType);
      expect(row.agent_id).toBe(event.agentId);
      expect(row.hmac).toBe(event.hmac);

      const back = auditEventFromDbRow(row);
      expect(back.id).toBe(event.id);
      expect(back.sessionId).toBe(event.sessionId);
      expect(back.eventType).toBe(event.eventType);
      expect(back.agentId).toBe(event.agentId);
      expect(back.hmac).toBe(event.hmac);
      expect(back.severity).toBe(event.severity);
    });
  });

  describe("shortSummary", () => {
    it("formats event with agent and time", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        sessionId: "s1",
        agentId: "a1",
        eventType: "tool_use",
        action: "read",
        details: null,
        filesAffected: null,
        gateId: null,
        hmac: null,
        severity: "info",
      };
      const summary = shortSummary(event);
      expect(summary).toContain("tool_use");
      expect(summary).toContain("read");
      expect(summary).toContain("a1");
    });

    it("uses [system] when agentId is null", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T12:00:00.000Z",
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
      const summary = shortSummary(event);
      expect(summary).toContain("[system]");
    });
  });
});
