/**
 * Tests for OpenTelemetry integration: init/shutdown, no-op when disabled,
 * getTracer/getMeter, and record* functions.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:net";
import { get } from "node:http";
import {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  getMeter,
  redactEndpointForLogs,
  recordSessionStart,
  recordAuditEvent,
  recordActiveAgentDelta,
  recordBoundaryViolation,
  recordToolDurationSeconds,
} from "../../src/engine/telemetry.js";
import type { K6sConfig } from "../../src/models/config.js";

function config(overrides: Partial<K6sConfig["observability"]> = {}): K6sConfig {
  return {
    version: "1",
    project: { name: "test" },
    session: {},
    boundaries: [],
    gates: [],
    observability: {
      prometheus: { enabled: false, port: 9090 },
      opentelemetry: { enabled: false, endpoint: "http://localhost:4318" },
      webhooks: [],
      ...overrides,
    },
    plugins: [],
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve ephemeral port.")));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
  });
}

async function waitForMetricEndpoint(
  url: string,
  timeoutMs = 4000,
): Promise<{ status: number; body: string }> {
  const startedAt = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Metrics endpoint did not become ready in ${timeoutMs}ms: ${String(lastErr)}`);
}

async function loadFreshTelemetry() {
  vi.resetModules();
  return await import("../../src/engine/telemetry.js");
}

describe("telemetry", () => {
  afterEach(async () => {
    await shutdownTelemetry().catch(() => {});
  });

  describe("when opentelemetry.enabled is false", () => {
    it("initTelemetry returns without throwing", () => {
      initTelemetry(config());
    });

    it("getTracer returns a tracer with startActiveSpan", () => {
      initTelemetry(config());
      const tracer = getTracer();
      expect(tracer).toBeDefined();
      expect(typeof tracer.startActiveSpan).toBe("function");
      tracer.startActiveSpan("test.span", (span) => {
        expect(span).toBeDefined();
        span.end();
      });
    });

    it("getMeter returns a meter", () => {
      initTelemetry(config());
      const meter = getMeter();
      expect(meter).toBeDefined();
    });

    it("record* functions do not throw when SDK not started", () => {
      recordSessionStart();
      recordAuditEvent("tool_use", "info");
      recordActiveAgentDelta(1);
      recordActiveAgentDelta(-1);
      recordBoundaryViolation("forbidden_path");
      recordToolDurationSeconds(1.5);
    });

    it("record* functions do not throw after init with enabled false", () => {
      initTelemetry(config());
      recordSessionStart();
      recordAuditEvent("session_start", "info");
      recordActiveAgentDelta(1);
      recordBoundaryViolation("forbidden_path");
      recordToolDurationSeconds(0.25);
    });
  });

  describe("when opentelemetry.enabled is true", () => {
    // Tests that start the SDK with a real OTLP endpoint require a collector or mock
    // and can trigger async export failures (EPERM/ECONNREFUSED) in CI/sandbox.
    // Manual verification: set enabled true and endpoint to a running collector, then
    // run session start/stop and confirm spans and metrics appear.
    it("getTracer and getMeter return when enabled true (no export in this test)", () => {
      initTelemetry(
        config({
          opentelemetry: { enabled: true, endpoint: "http://127.0.0.1:4318" },
        }),
      );
      const tracer = getTracer();
      const meter = getMeter();
      expect(tracer).toBeDefined();
      expect(meter).toBeDefined();
      // Do not create spans or record metrics to avoid triggering async export.
    });
  });

  describe("shutdownTelemetry", () => {
    it("resolves when SDK was never started", async () => {
      await shutdownTelemetry();
    });
  });

  describe("prometheus exporter", () => {
    it("serves expected metrics when prometheus is enabled without OTLP", async () => {
      const telemetry = await loadFreshTelemetry();
      const port = await getFreePort();
      telemetry.initTelemetry(
        config({
          prometheus: { enabled: true, port },
          opentelemetry: { enabled: false, endpoint: "http://localhost:4318" },
        }),
      );
      telemetry.recordSessionStart();
      telemetry.recordAuditEvent("tool_use", "info");
      telemetry.recordActiveAgentDelta(1);
      telemetry.recordBoundaryViolation("forbidden_path");
      telemetry.recordToolDurationSeconds(0.42);
      const meter = telemetry.getMeter();
      const smokeCounter = meter.createCounter("k6s_prometheus_test_total", {
        description: "Prometheus smoke test counter",
      });
      smokeCounter.add(1);

      const res = await waitForMetricEndpoint(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("target_info");
      await telemetry.shutdownTelemetry();
    });

    it("stops serving metrics after shutdownTelemetry", async () => {
      const telemetry = await loadFreshTelemetry();
      const port = await getFreePort();
      telemetry.initTelemetry(
        config({
          prometheus: { enabled: true, port },
          opentelemetry: { enabled: false, endpoint: "http://localhost:4318" },
        }),
      );
      await waitForMetricEndpoint(`http://127.0.0.1:${port}/metrics`);
      await telemetry.shutdownTelemetry();

      await expect(httpGet(`http://127.0.0.1:${port}/metrics`)).rejects.toBeDefined();
    });
  });

  describe("redactEndpointForLogs", () => {
    it("redacts userinfo credentials in URL", () => {
      const redacted = redactEndpointForLogs("https://alice:secret@otel.example.com/v1/traces");
      expect(redacted).toContain("https://***:***@otel.example.com");
      expect(redacted).not.toContain("secret");
    });

    it("redacts common secret query params", () => {
      const redacted = redactEndpointForLogs("https://otel.example.com/v1/traces?api_key=abc123&env=prod");
      expect(redacted).toContain("api_key=***");
      expect(redacted).toContain("env=prod");
      expect(redacted).not.toContain("abc123");
    });

    it("falls back gracefully for non-url strings", () => {
      const redacted = redactEndpointForLogs("grpc://alice:secret@collector.internal?token=abc");
      expect(redacted).toContain("grpc://***:***@collector.internal");
      expect(redacted).toContain("token=***");
      expect(redacted).not.toContain("secret");
      expect(redacted).not.toContain("abc");
    });
  });
});
