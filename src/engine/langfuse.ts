/**
 * Langfuse LLM observability integration.
 *
 * Provides session-level traces, agent-level spans, and tool-level generations
 * with token usage and cost attribution. Disabled by default — opt-in via
 * observability.langfuse.enabled in k6s.yaml.
 *
 * Hooks are short-lived processes, so we initialize and flush per invocation.
 */

import { Langfuse } from "langfuse";
import type { LangfuseTraceClient, LangfuseSpanClient } from "langfuse";
import type { K6sConfig, LangfuseConfig } from "../models/config.js";
import { resolveSecret } from "../models/config.js";
import { VERSION } from "../version.js";

let client: Langfuse | null = null;

/**
 * Initialize the Langfuse client from config.
 * No-op when langfuse is disabled or keys are missing.
 */
export function initLangfuse(config: K6sConfig): void {
  if (client) return; // Idempotent.
  const lf = config.observability?.langfuse;
  if (!lf?.enabled) return;

  const secretKey = resolveSecret(lf.secret_key);
  const publicKey = resolveSecret(lf.public_key);
  if (!secretKey || !publicKey) {
    console.error(
      "Warning: Langfuse enabled but secret_key or public_key could not be resolved. Skipping.",
    );
    return;
  }

  client = new Langfuse({
    secretKey,
    publicKey,
    baseUrl: lf.base_url ?? "https://cloud.langfuse.com",
    flushAt: lf.flush_at ?? 15,
    flushInterval: lf.flush_interval ?? 5000,
    release: VERSION,
  });
}

/**
 * Flush pending events and shut down the Langfuse client.
 * Must be called before process exit in short-lived hook processes.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdownAsync();
  } catch {
    // Best-effort — don't block process exit.
  }
  client = null;
}

/** Return true if Langfuse is initialized and active. */
export function isLangfuseActive(): boolean {
  return client !== null;
}

/**
 * Create a Langfuse trace for a governed session.
 * Called on `team start` and `team resume`.
 */
export function createSessionTrace(opts: {
  sessionId: string;
  objective: string;
  operator?: string | null;
  gitBranch?: string | null;
  gitSha?: string | null;
  traceId?: string | null;
}): LangfuseTraceClient | null {
  if (!client) return null;

  return client.trace({
    id: opts.sessionId,
    sessionId: opts.sessionId,
    name: opts.objective,
    userId: opts.operator ?? undefined,
    metadata: {
      source: "khoregos",
      k6s_version: VERSION,
      git_branch: opts.gitBranch ?? null,
      git_sha: opts.gitSha ?? null,
      trace_id: opts.traceId ?? null,
    },
    tags: ["khoregos"],
  });
}

/**
 * Update a session trace (e.g. to mark completion).
 */
export function updateSessionTrace(opts: {
  sessionId: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!client) return;

  client.trace({
    id: opts.sessionId,
    metadata: opts.metadata,
  });
}

/**
 * Create a span for an agent within a session trace.
 * Called on `subagent-start`.
 */
export function createAgentSpan(opts: {
  sessionId: string;
  agentId: string;
  agentName: string;
  role?: string;
}): LangfuseSpanClient | null {
  if (!client) return null;

  const trace = client.trace({ id: opts.sessionId });
  return trace.span({
    id: opts.agentId,
    name: opts.agentName,
    metadata: {
      role: opts.role ?? "agent",
    },
  });
}

/**
 * End an agent span.
 * Called on `subagent-stop`.
 */
export function endAgentSpan(opts: {
  sessionId: string;
  agentId: string;
}): void {
  if (!client) return;

  // Re-reference the span and end it.
  const trace = client.trace({ id: opts.sessionId });
  const span = trace.span({ id: opts.agentId, name: "agent" });
  span.end();
}

/**
 * Record a tool use as a Langfuse generation.
 * Called on `post-tool-use` when token usage is available.
 */
export function recordGeneration(opts: {
  sessionId: string;
  agentId?: string | null;
  name: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  startTime?: Date;
  endTime?: Date;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  costUsd?: number;
  metadata?: Record<string, unknown>;
}): void {
  if (!client) return;

  const trace = client.trace({ id: opts.sessionId });
  const parent = opts.agentId ? trace.span({ id: opts.agentId, name: "agent" }) : trace;

  parent.generation({
    name: opts.name,
    model: opts.model,
    input: opts.input ?? null,
    output: opts.output ?? null,
    startTime: opts.startTime,
    endTime: opts.endTime,
    usage: opts.usage
      ? {
          input: opts.usage.inputTokens,
          output: opts.usage.outputTokens,
          inputCost: undefined,
          outputCost: undefined,
          totalCost: opts.costUsd,
        }
      : undefined,
    metadata: {
      source: "khoregos",
      ...opts.metadata,
    },
  });
}

/**
 * Record an audit event as a Langfuse event (non-generation observation).
 * Used for boundary violations, gate triggers, and other governance events.
 */
export function recordLangfuseEvent(opts: {
  sessionId: string;
  agentId?: string | null;
  name: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!client) return;

  const trace = client.trace({ id: opts.sessionId });
  const parent = opts.agentId ? trace.span({ id: opts.agentId, name: "agent" }) : trace;

  parent.event({
    name: opts.name,
    metadata: {
      source: "khoregos",
      ...opts.metadata,
    },
  });
}

/**
 * Attach a numeric score to a session trace.
 * Used for session-level cost attribution.
 */
export function scoreSession(opts: {
  sessionId: string;
  name: string;
  value: number;
  comment?: string;
}): void {
  if (!client) return;

  const trace = client.trace({ id: opts.sessionId });
  trace.score({
    name: opts.name,
    value: opts.value,
    comment: opts.comment,
  });
}
