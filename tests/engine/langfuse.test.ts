/**
 * Tests for the Langfuse observability integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the langfuse module before importing anything that uses it.
const mockTrace = vi.fn();
const mockShutdownAsync = vi.fn(async () => {});
const mockLangfuseConstructor = vi.fn();

vi.mock("langfuse", () => ({
  Langfuse: class MockLangfuse {
    constructor(params: Record<string, unknown>) {
      mockLangfuseConstructor(params);
    }
    trace = mockTrace;
    shutdownAsync = mockShutdownAsync;
  },
}));

import type { K6sConfig } from "../../src/models/config.js";

// Dynamic import so mocks are in place.
let initLangfuse: typeof import("../../src/engine/langfuse.js")["initLangfuse"];
let shutdownLangfuse: typeof import("../../src/engine/langfuse.js")["shutdownLangfuse"];
let isLangfuseActive: typeof import("../../src/engine/langfuse.js")["isLangfuseActive"];
let createSessionTrace: typeof import("../../src/engine/langfuse.js")["createSessionTrace"];
let recordGeneration: typeof import("../../src/engine/langfuse.js")["recordGeneration"];
let recordLangfuseEvent: typeof import("../../src/engine/langfuse.js")["recordLangfuseEvent"];
let scoreSession: typeof import("../../src/engine/langfuse.js")["scoreSession"];

function makeConfig(overrides: Record<string, unknown> = {}): K6sConfig {
  return {
    version: "1",
    project: { name: "test" },
    session: {
      context_retention_days: 90,
      audit_retention_days: 365,
      session_retention_days: 365,
      end_on_claude_exit: true,
    },
    classifications: [],
    boundaries: [],
    gates: [],
    observability: {
      prometheus: { enabled: false, port: 9090 },
      opentelemetry: { enabled: false, endpoint: "http://localhost:4317" },
      langfuse: {
        enabled: false,
        base_url: "https://cloud.langfuse.com",
        flush_at: 15,
        flush_interval: 5000,
        ...overrides,
      },
      webhooks: [],
    },
    transcript: {
      store: "off",
      strip_thinking: true,
      ner_redaction: true,
      max_content_length: 50000,
      redaction_patterns: [],
    },
    plugins: [],
  } as K6sConfig;
}

describe("Langfuse integration", () => {
  beforeEach(async () => {
    // Reset module state between tests by re-importing.
    vi.resetModules();
    mockLangfuseConstructor.mockClear();
    mockTrace.mockClear();
    mockShutdownAsync.mockClear();

    const mod = await import("../../src/engine/langfuse.js");
    initLangfuse = mod.initLangfuse;
    shutdownLangfuse = mod.shutdownLangfuse;
    isLangfuseActive = mod.isLangfuseActive;
    createSessionTrace = mod.createSessionTrace;
    recordGeneration = mod.recordGeneration;
    recordLangfuseEvent = mod.recordLangfuseEvent;
    scoreSession = mod.scoreSession;
  });

  afterEach(async () => {
    await shutdownLangfuse();
  });

  describe("initLangfuse", () => {
    it("does nothing when langfuse is disabled", () => {
      const config = makeConfig({ enabled: false });
      initLangfuse(config);
      expect(isLangfuseActive()).toBe(false);
      expect(mockLangfuseConstructor).not.toHaveBeenCalled();
    });

    it("does nothing when keys are missing", () => {
      const config = makeConfig({ enabled: true });
      initLangfuse(config);
      expect(isLangfuseActive()).toBe(false);
    });

    it("initializes client with resolved keys", () => {
      process.env.TEST_LF_SECRET = "sk-test-secret";
      process.env.TEST_LF_PUBLIC = "pk-test-public";
      const config = makeConfig({
        enabled: true,
        secret_key: "$TEST_LF_SECRET",
        public_key: "$TEST_LF_PUBLIC",
        base_url: "https://self-hosted.example.com",
      });
      initLangfuse(config);
      expect(isLangfuseActive()).toBe(true);
      expect(mockLangfuseConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          secretKey: "sk-test-secret",
          publicKey: "pk-test-public",
          baseUrl: "https://self-hosted.example.com",
        }),
      );
      delete process.env.TEST_LF_SECRET;
      delete process.env.TEST_LF_PUBLIC;
    });

    it("is idempotent on repeated calls", () => {
      process.env.TEST_LF_SECRET2 = "sk-x";
      process.env.TEST_LF_PUBLIC2 = "pk-x";
      const config = makeConfig({
        enabled: true,
        secret_key: "$TEST_LF_SECRET2",
        public_key: "$TEST_LF_PUBLIC2",
      });
      initLangfuse(config);
      initLangfuse(config);
      expect(mockLangfuseConstructor).toHaveBeenCalledTimes(1);
      delete process.env.TEST_LF_SECRET2;
      delete process.env.TEST_LF_PUBLIC2;
    });
  });

  describe("shutdownLangfuse", () => {
    it("flushes and nullifies the client", async () => {
      process.env.TEST_LF_SECRET3 = "sk-y";
      process.env.TEST_LF_PUBLIC3 = "pk-y";
      const config = makeConfig({
        enabled: true,
        secret_key: "$TEST_LF_SECRET3",
        public_key: "$TEST_LF_PUBLIC3",
      });
      initLangfuse(config);
      expect(isLangfuseActive()).toBe(true);
      await shutdownLangfuse();
      expect(mockShutdownAsync).toHaveBeenCalled();
      expect(isLangfuseActive()).toBe(false);
      delete process.env.TEST_LF_SECRET3;
      delete process.env.TEST_LF_PUBLIC3;
    });

    it("is safe to call when not initialized", async () => {
      await shutdownLangfuse(); // Should not throw.
      expect(mockShutdownAsync).not.toHaveBeenCalled();
    });
  });

  describe("createSessionTrace", () => {
    it("returns null when client is not active", () => {
      const result = createSessionTrace({
        sessionId: "s1",
        objective: "test",
      });
      expect(result).toBeNull();
    });

    it("creates a trace with session metadata when active", () => {
      process.env.TEST_LF_SECRET4 = "sk-z";
      process.env.TEST_LF_PUBLIC4 = "pk-z";
      mockTrace.mockReturnValue({ id: "trace-1" });
      initLangfuse(makeConfig({
        enabled: true,
        secret_key: "$TEST_LF_SECRET4",
        public_key: "$TEST_LF_PUBLIC4",
      }));

      createSessionTrace({
        sessionId: "s1",
        objective: "build feature",
        operator: "alice",
        gitBranch: "main",
        gitSha: "abc123",
        traceId: "t1",
      });

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s1",
          sessionId: "s1",
          name: "build feature",
          userId: "alice",
          tags: ["khoregos"],
        }),
      );
      delete process.env.TEST_LF_SECRET4;
      delete process.env.TEST_LF_PUBLIC4;
    });
  });

  describe("recordGeneration", () => {
    it("is a no-op when client is not active", () => {
      recordGeneration({
        sessionId: "s1",
        name: "Edit",
      });
      expect(mockTrace).not.toHaveBeenCalled();
    });
  });

  describe("recordLangfuseEvent", () => {
    it("is a no-op when client is not active", () => {
      recordLangfuseEvent({
        sessionId: "s1",
        name: "gate_triggered",
      });
      expect(mockTrace).not.toHaveBeenCalled();
    });
  });

  describe("scoreSession", () => {
    it("is a no-op when client is not active", () => {
      scoreSession({
        sessionId: "s1",
        name: "total_cost_usd",
        value: 1.5,
      });
      expect(mockTrace).not.toHaveBeenCalled();
    });
  });
});
