/**
 * OpenTelemetry integration: init/shutdown, tracer, meter, and metric instruments.
 * When observability.opentelemetry.enabled is false, no SDK is registered and
 * all OTel API calls use no-op implementations (zero overhead).
 */

import { trace, metrics } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { K6sConfig } from "../models/config.js";
import { VERSION } from "../version.js";

const SERVICE_NAME = "khoregos";
const TRACER_NAME = "khoregos";
const METER_NAME = "khoregos";

let sdk: NodeSDK | null = null;

/** Histogram buckets for tool duration in seconds (0.1, 0.5, 1, 5, 10, 30, 60, 300). */
const TOOL_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 10, 30, 60, 300];

function normalizeEndpoint(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/$/, "");
  return base.includes("/v1/") ? base : `${base}${path}`;
}

/**
 * Redact credential-like material from endpoint strings for safe logging.
 * This only affects display output and never changes runtime exporter config.
 */
export function redactEndpointForLogs(endpoint: string): string {
  const redactQueryParams = (url: URL): void => {
    for (const key of Array.from(url.searchParams.keys())) {
      const k = key.toLowerCase();
      if (
        k === "token" ||
        k === "apikey" ||
        k === "api_key" ||
        k === "access_token" ||
        k === "auth" ||
        k === "authorization"
      ) {
        url.searchParams.set(key, "***");
      }
    }
  };

  try {
    const url = new URL(endpoint);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    redactQueryParams(url);
    return url.toString();
  } catch {
    // Best-effort fallback for non-URL strings.
    let redacted = endpoint.replace(/:\/\/([^:@/?#]+):([^@/?#]+)@/g, "://***:***@");
    redacted = redacted.replace(
      /([?&])(token|apikey|api_key|access_token|auth|authorization)=([^&]+)/gi,
      "$1$2=***",
    );
    return redacted;
  }
}

/**
 * Initialize OpenTelemetry SDK when config has observability.opentelemetry.enabled.
 * Otherwise does nothing (no-op providers remain in use).
 */
export function initTelemetry(config: K6sConfig): void {
  if (sdk) return; // Already initialized — idempotent.
  const otel = config.observability?.opentelemetry;
  if (!otel?.enabled) return;

  const endpoint = otel.endpoint ?? "http://localhost:4318";
  const tracesUrl = normalizeEndpoint(endpoint, "/v1/traces");
  const metricsUrl = normalizeEndpoint(endpoint, "/v1/metrics");

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME,
    "service.version": VERSION,
  });

  const traceExporter = new OTLPTraceExporter({ url: tracesUrl });
  const metricExporter = new OTLPMetricExporter({ url: metricsUrl });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10_000,
  });

  // SimpleSpanProcessor exports each span when it ends. This is more reliable
  // for short-lived processes (CLI, hooks) than BatchSpanProcessor, which
  // may not flush before process exit.
  const spanProcessor = new SimpleSpanProcessor(traceExporter);

  // Cast required: sdk-node bundles its own @opentelemetry/sdk-metrics with a
  // separate private _shutdown declaration. This is a known OTel version skew
  // issue. The runtime types are compatible; only the private field diverges.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    metricReader: metricReader as any,
  });
  sdk.start();
}

const SHUTDOWN_TIMEOUT_MS = 5000;

/** Short delay before shutdown so in-flight exports (e.g. SimpleSpanProcessor) can complete. */
const PRE_SHUTDOWN_DELAY_MS = 500;

/**
 * Shutdown the OpenTelemetry SDK and flush pending exports.
 * Call after session stop (or when tearing down the process).
 * If the Collector is unreachable, shutdown is capped at SHUTDOWN_TIMEOUT_MS
 * so the process does not hang.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await new Promise((r) => setTimeout(r, PRE_SHUTDOWN_DELAY_MS));
  const shutdown = sdk.shutdown();
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
  );
  await Promise.race([shutdown, timeout]);
  sdk = null;
}

/**
 * Return the tracer for the khoregos service.
 * Uses the global tracer provider (no-op if initTelemetry was never called with enabled).
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME, VERSION);
}

/**
 * Return the meter for the khoregos service.
 * Uses the global meter provider (no-op if initTelemetry was never called with enabled).
 */
export function getMeter() {
  return metrics.getMeter(METER_NAME, VERSION);
}

// Lazy-created metric instruments (created on first use; no-op when SDK not started).
let sessionsTotalCounter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null =
  null;
let auditEventsTotalCounter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null =
  null;
let activeAgentsUpDown: ReturnType<ReturnType<typeof getMeter>["createUpDownCounter"]> | null =
  null;
let boundaryViolationsCounter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null =
  null;
let toolDurationHistogram: ReturnType<ReturnType<typeof getMeter>["createHistogram"]> | null =
  null;

function getSessionsTotalCounter() {
  if (!sessionsTotalCounter) {
    sessionsTotalCounter = getMeter().createCounter("k6s_sessions_total", {
      description: "Total number of k6s sessions started",
    });
  }
  return sessionsTotalCounter;
}

function getAuditEventsTotalCounter() {
  if (!auditEventsTotalCounter) {
    auditEventsTotalCounter = getMeter().createCounter("k6s_audit_events_total", {
      description: "Total number of audit events logged",
    });
  }
  return auditEventsTotalCounter;
}

function getActiveAgentsUpDown() {
  if (!activeAgentsUpDown) {
    activeAgentsUpDown = getMeter().createUpDownCounter("k6s_active_agents", {
      description: "Number of active agents",
    });
  }
  return activeAgentsUpDown;
}

function getBoundaryViolationsCounter() {
  if (!boundaryViolationsCounter) {
    boundaryViolationsCounter = getMeter().createCounter(
      "k6s_boundary_violations_total",
      { description: "Total number of boundary violations" },
    );
  }
  return boundaryViolationsCounter;
}

function getToolDurationHistogram() {
  if (!toolDurationHistogram) {
    toolDurationHistogram = getMeter().createHistogram(
      "k6s_tool_duration_seconds",
      {
        description: "Tool call duration in seconds",
        unit: "s",
        advice: { explicitBucketBoundaries: TOOL_DURATION_BUCKETS },
      },
    );
  }
  return toolDurationHistogram;
}

/** Record that a session was started (increment k6s_sessions_total). */
export function recordSessionStart(): void {
  getSessionsTotalCounter().add(1);
}

/** Record an audit event (increment k6s_audit_events_total with event_type and severity). */
export function recordAuditEvent(eventType: string, severity: string): void {
  getAuditEventsTotalCounter().add(1, { event_type: eventType, severity });
}

/** Add or subtract active agents (e.g. +1 on subagent-start, -1 on subagent-stop). */
export function recordActiveAgentDelta(delta: number): void {
  getActiveAgentsUpDown().add(delta);
}

/** Record a boundary violation (increment k6s_boundary_violations_total). */
export function recordBoundaryViolation(violationType: string): void {
  getBoundaryViolationsCounter().add(1, { violation_type: violationType });
}

/** Record a tool call duration in seconds (k6s_tool_duration_seconds histogram). */
export function recordToolDurationSeconds(seconds: number): void {
  getToolDurationHistogram().record(seconds);
}

export { TOOL_DURATION_BUCKETS };
