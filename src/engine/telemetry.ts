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
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import type { K6sConfig } from "../models/config.js";
import { VERSION } from "../version.js";

const SERVICE_NAME = "khoregos";
const TRACER_NAME = "khoregos";
const METER_NAME = "khoregos";

let sdk: NodeSDK | null = null;
let meterProvider: MeterProvider | null = null;
let prometheusExporter: PrometheusExporter | null = null;

/** Histogram buckets for tool duration in seconds (0.1, 0.5, 1, 5, 10, 30, 60, 300). */
const TOOL_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 10, 30, 60, 300];

function normalizeEndpoint(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/$/, "");
  return base.includes("/v1/") ? base : `${base}${path}`;
}

function isHookCommandProcess(): boolean {
  return process.argv[2] === "hook";
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
  if (sdk || meterProvider) return; // Already initialized — idempotent.
  const otel = config.observability?.opentelemetry;
  const prometheus = config.observability?.prometheus;

  const isOtelEnabled = otel?.enabled === true;
  const isPrometheusEnabled = prometheus?.enabled === true;
  if (!isOtelEnabled && !isPrometheusEnabled) return;

  const endpoint = otel.endpoint ?? "http://localhost:4318";
  const tracesUrl = normalizeEndpoint(endpoint, "/v1/traces");
  const metricsUrl = normalizeEndpoint(endpoint, "/v1/metrics");

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME,
    "service.version": VERSION,
  });

  const metricReaders: MetricReader[] = [];
  if (isOtelEnabled) {
    const metricExporter = new OTLPMetricExporter({ url: metricsUrl });
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 10_000,
    });
    metricReaders.push(metricReader);
  }

  // Hook subprocesses are short-lived and should not attempt to bind a
  // long-lived Prometheus listener port on every hook invocation.
  if (isPrometheusEnabled && !isHookCommandProcess()) {
    const port = prometheus.port ?? 9090;
    const exporter = new PrometheusExporter(
      { port, preventServerStart: false },
      (error) => {
        if (!error) return;
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EADDRINUSE") {
          console.error(
            `Warning: Prometheus metrics port ${port} is already in use. Metrics endpoint disabled.`,
          );
          return;
        }
        console.error(
          `Warning: Failed to start Prometheus metrics endpoint on port ${port}: ${err.message}.`,
        );
      },
    );
    prometheusExporter = exporter;

    // Cast required: exporter-prometheus can depend on a different OTel metrics
    // package version than sdk-node/sdk-metrics in this repo. Runtime behavior
    // is compatible; only private class fields differ across package copies.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metricReaders.push(exporter as any);
  }

  if (metricReaders.length > 0) {
    // Cast required: NodeSDK and SDK metrics can carry parallel OTel package
    // copies with diverging private fields, but they are runtime-compatible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meterProvider = new MeterProvider({ resource, readers: metricReaders as any });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  if (!isOtelEnabled) return;

  // SimpleSpanProcessor exports each span when it ends. This is more reliable
  // for short-lived processes (CLI, hooks) than BatchSpanProcessor, which
  // may not flush before process exit.
  const traceExporter = new OTLPTraceExporter({ url: tracesUrl });
  const spanProcessor = new SimpleSpanProcessor(traceExporter);

  // Cast required: sdk-node can resolve a different internal copy of
  // sdk-trace-base than this direct import, causing private-field type skew.
  // Runtime behavior is compatible even when TypeScript sees distinct classes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk = new NodeSDK({
    resource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spanProcessors: [spanProcessor as any],
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
  if (!sdk && !meterProvider) {
    sessionsTotalCounter = null;
    auditEventsTotalCounter = null;
    activeAgentsUpDown = null;
    boundaryViolationsCounter = null;
    toolDurationHistogram = null;
    return;
  }

  if (sdk) {
    await new Promise((r) => setTimeout(r, PRE_SHUTDOWN_DELAY_MS));
    const shutdown = sdk.shutdown();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
    );
    await Promise.race([shutdown, timeout]);
    sdk = null;
  }

  if (meterProvider) {
    const shutdown = meterProvider.shutdown();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
    );
    await Promise.race([shutdown, timeout]);
    meterProvider = null;
    prometheusExporter = null;
  }

  sessionsTotalCounter = null;
  auditEventsTotalCounter = null;
  activeAgentsUpDown = null;
  boundaryViolationsCounter = null;
  toolDurationHistogram = null;
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
export function recordSessionStart(amount = 1): void {
  if (amount <= 0) return;
  getSessionsTotalCounter().add(amount);
}

/** Record an audit event (increment k6s_audit_events_total with event_type and severity). */
export function recordAuditEvent(eventType: string, severity: string, amount = 1): void {
  if (amount <= 0) return;
  getAuditEventsTotalCounter().add(amount, { event_type: eventType, severity });
}

/** Add or subtract active agents (e.g. +1 on subagent-start, -1 on subagent-stop). */
export function recordActiveAgentDelta(delta: number): void {
  getActiveAgentsUpDown().add(delta);
}

/** Record a boundary violation (increment k6s_boundary_violations_total). */
export function recordBoundaryViolation(violationType: string, amount = 1): void {
  if (amount <= 0) return;
  getBoundaryViolationsCounter().add(amount, { violation_type: violationType });
}

/** Record a tool call duration in seconds (k6s_tool_duration_seconds histogram). */
export function recordToolDurationSeconds(seconds: number): void {
  getToolDurationHistogram().record(seconds);
}

export { TOOL_DURATION_BUCKETS };
