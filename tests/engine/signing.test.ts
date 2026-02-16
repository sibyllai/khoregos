/**
 * Tests for HMAC signing: key generation, canonicalize, computeHmac, verifyChain.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  generateSigningKey,
  loadSigningKey,
  canonicalizeEvent,
  computeHmac,
  genesisValue,
  verifyChain,
  type AuditEvent,
} from "../../src/engine/signing.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

describe("signing", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "k6s-signing-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true });
  });

  describe("generateSigningKey", () => {
    it("creates key file and returns true on first call", () => {
      const created = generateSigningKey(tempDir);
      expect(created).toBe(true);
    });

    it("returns false when key already exists", () => {
      const created = generateSigningKey(tempDir);
      expect(created).toBe(false);
    });
  });

  describe("loadSigningKey", () => {
    it("returns Buffer when key file exists", () => {
      const key = loadSigningKey(tempDir);
      expect(key).toBeInstanceOf(Buffer);
      expect(key!.length).toBe(32);
    });

    it("returns null when key file does not exist", () => {
      const key = loadSigningKey(path.join(tempDir, "nonexistent"));
      expect(key).toBeNull();
    });
  });

  describe("genesisValue", () => {
    it("returns session-prefixed string", () => {
      expect(genesisValue("sess-123")).toBe("k6s:genesis:sess-123");
    });
  });

  describe("canonicalizeEvent", () => {
    it("excludes hmac field and sorts keys", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        sessionId: "s1",
        agentId: null,
        eventType: "session_start",
        action: "start",
        details: null,
        filesAffected: null,
        gateId: null,
        hmac: "ignored",
        severity: "info",
      };
      const canon = canonicalizeEvent(event);
      expect(canon).not.toContain("hmac");
      expect(canon).toContain("action");
      expect(canon).toContain("session_start");
    });
  });

  describe("computeHmac", () => {
    it("produces deterministic hex string", () => {
      const key = loadSigningKey(tempDir)!;
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
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
      const h1 = computeHmac(key, genesisValue("s1"), event);
      const h2 = computeHmac(key, genesisValue("s1"), event);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different HMAC for different previous chain value", () => {
      const key = loadSigningKey(tempDir)!;
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
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
      const h1 = computeHmac(key, genesisValue("s1"), event);
      const h2 = computeHmac(key, "other-prev", event);
      expect(h1).not.toBe(h2);
    });
  });

  describe("verifyChain", () => {
    const key = Buffer.alloc(32, "a");

    it("returns valid for empty events", () => {
      const result = verifyChain(key, "s1", []);
      expect(result.valid).toBe(true);
      expect(result.eventsChecked).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("returns valid for a correct single-event chain", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
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
      event.hmac = computeHmac(key, genesisValue("s1"), event);
      const result = verifyChain(key, "s1", [event]);
      expect(result.valid).toBe(true);
      expect(result.eventsChecked).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("reports missing HMAC", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
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
      const result = verifyChain(key, "s1", [event]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "missing")).toBe(true);
    });

    it("reports HMAC mismatch", () => {
      const event: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        sessionId: "s1",
        agentId: null,
        eventType: "session_start",
        action: "start",
        details: null,
        filesAffected: null,
        gateId: null,
        hmac: "wrong",
        severity: "info",
      };
      const result = verifyChain(key, "s1", [event]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "mismatch")).toBe(true);
    });

    it("reports sequence gap", () => {
      const e1: AuditEvent = {
        id: "01",
        timestamp: "2026-01-01T00:00:00.000Z",
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
      e1.hmac = computeHmac(key, genesisValue("s1"), e1);
      const e2: AuditEvent = {
        ...e1,
        id: "02",
        sequence: 3,
        eventType: "tool_use",
        action: "run",
      };
      e2.hmac = computeHmac(key, e1.hmac!, e2);
      const result = verifyChain(key, "s1", [e1, e2]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "gap")).toBe(true);
    });
  });
});
