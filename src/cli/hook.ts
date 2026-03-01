/**
 * Claude Code hook handlers.
 *
 * Invoked automatically by Claude Code hooks on every tool call,
 * subagent spawn/stop, and session stop. Provides non-cooperative
 * audit logging — agents don't need to voluntarily call MCP tools.
 *
 * Each handler reads JSON from stdin, extracts relevant fields,
 * and writes an audit event to SQLite synchronously.
 */

import { existsSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfigOrDefault } from "../models/config.js";
import { DaemonState } from "../daemon/manager.js";
import { AuditLogger, setWebhookDispatcher } from "../engine/audit.js";
import { BoundaryEnforcer, revertFile } from "../engine/boundaries.js";
import { StateManager } from "../engine/state.js";
import { classifySeverity, extractPathsFromBashCommand } from "../engine/severity.js";
import { loadSigningKey } from "../engine/signing.js";
import {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  recordActiveAgentDelta,
  recordToolDurationSeconds,
} from "../engine/telemetry.js";
import { detectDependencyChanges } from "../engine/dependencies.js";
import { ReviewPatternMatcher } from "../watcher/fs.js";
import { Db } from "../store/db.js";
import type { EventType } from "../models/audit.js";
import { WebhookDispatcher } from "../engine/webhooks.js";

// Maximum bytes to read from stdin before aborting (1 MB).
// Hook payloads are small JSON objects; anything larger is anomalous.
const MAX_STDIN_BYTES = 1_048_576;
const MAX_DURATION_MS = 3_600_000;

function readHookInput(): Record<string, unknown> {
  try {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const buf = Buffer.alloc(65_536);

    // Read stdin in chunks with a size cap.
    while (true) {
      let bytesRead: number;
      try {
        bytesRead = readSync(0, buf, 0, buf.length, null);
      } catch {
        break; // EOF or read error.
      }
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_STDIN_BYTES) return {};
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }

    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve the project root for hook invocations. Claude Code may run hooks with
 * cwd = workspace root (e.g. repo root) while the active session lives in a
 * subdirectory (e.g. prototypes/13). We look in cwd, then ancestors, then
 * immediate children so that hooks find .khoregos and k6s.yaml in the right place.
 */
function resolveHookProjectRoot(): string | null {
  let dir = process.cwd();
  const seen = new Set<string>();

  // Check cwd and ancestors.
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const state = new DaemonState(path.join(dir, ".khoregos"));
    if (state.isRunning()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // One level of children (e.g. repo root -> prototypes/13).
  const cwd = process.cwd();
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(cwd, e.name);
      if (seen.has(child)) continue;
      const state = new DaemonState(path.join(child, ".khoregos"));
      if (state.isRunning()) return child;
    }
  } catch {
    // Ignore readdir errors (e.g. permission).
  }

  return null;
}

function getSessionId(projectRoot: string): string | null {
  const state = new DaemonState(path.join(projectRoot, ".khoregos"));
  if (!state.isRunning()) return null;
  return (state.readState().session_id as string) ?? null;
}

function truncate(obj: unknown, maxLen = 2000): unknown {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length > maxLen) return s.slice(0, maxLen) + "...[truncated]";
  return obj;
}

export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Treat large values as milliseconds, otherwise as seconds.
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function extractDurationMs(data: Record<string, unknown>): number | undefined {
  const numericCandidates = [
    data.duration_ms,
    data.durationMs,
    data.elapsed_ms,
    data.elapsedMs,
    (data.timing as Record<string, unknown> | undefined)?.duration_ms,
    (data.timing as Record<string, unknown> | undefined)?.durationMs,
    (data.timing as Record<string, unknown> | undefined)?.elapsed_ms,
    (data.timing as Record<string, unknown> | undefined)?.elapsedMs,
  ];

  for (const candidate of numericCandidates) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0 &&
      candidate <= MAX_DURATION_MS
    ) {
      return candidate;
    }
  }

  const startCandidates = [
    data.started_at,
    data.start_time,
    data.startTime,
    (data.timing as Record<string, unknown> | undefined)?.started_at,
    (data.timing as Record<string, unknown> | undefined)?.start_time,
    (data.timing as Record<string, unknown> | undefined)?.startTime,
  ];
  const endCandidates = [
    data.ended_at,
    data.finished_at,
    data.end_time,
    data.endTime,
    data.timestamp,
    (data.timing as Record<string, unknown> | undefined)?.ended_at,
    (data.timing as Record<string, unknown> | undefined)?.finished_at,
    (data.timing as Record<string, unknown> | undefined)?.end_time,
    (data.timing as Record<string, unknown> | undefined)?.endTime,
    (data.timing as Record<string, unknown> | undefined)?.timestamp,
  ];

  const startMs = startCandidates
    .map(parseTimestampMs)
    .find((v): v is number => v != null);
  const endMs = endCandidates
    .map(parseTimestampMs)
    .find((v): v is number => v != null);

  if (startMs == null || endMs == null) return undefined;
  const duration = endMs - startMs;
  if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_MS) return undefined;
  return duration;
}

function configureHookWebhooks(projectRoot: string): void {
  const configPath = path.join(projectRoot, "k6s.yaml");
  if (!existsSync(configPath)) {
    setWebhookDispatcher(null);
    return;
  }
  const config = loadConfigOrDefault(configPath, "project");
  if (config.observability?.webhooks?.length) {
    setWebhookDispatcher(new WebhookDispatcher(config.observability.webhooks));
  } else {
    setWebhookDispatcher(null);
  }
}

/**
 * Initialize OTel in hook subprocess. Hooks are short-lived processes,
 * so the SDK must be initialized per invocation for spans/metrics to export.
 */
function initHookTelemetry(projectRoot: string): void {
  const configPath = path.join(projectRoot, "k6s.yaml");
  if (!existsSync(configPath)) return;
  const config = loadConfigOrDefault(configPath, "project");
  initTelemetry(config);
}

function logEvent(opts: {
  projectRoot: string;
  sessionId: string;
  eventType: EventType;
  action: string;
  details?: Record<string, unknown>;
  agentId?: string | null;
  filesAffected?: string[];
  severity?: "info" | "warning" | "critical";
}): void {
  const khoregoDir = path.join(opts.projectRoot, ".khoregos");
  const db = new Db(path.join(khoregoDir, "k6s.db"));
  db.connect();
  try {
    const key = loadSigningKey(khoregoDir);
    const sm = new StateManager(db, opts.projectRoot);
    const sess = sm.getSession(opts.sessionId);
    const logger = new AuditLogger(db, opts.sessionId, sess?.traceId, key);
    logger.start();
    logger.log({
      eventType: opts.eventType,
      action: opts.action,
      agentId: opts.agentId,
      details: opts.details,
      filesAffected: opts.filesAffected,
      severity: opts.severity,
    });
    logger.stop();
  } finally {
    db.close();
  }
}

export function registerHookCommands(program: Command): void {
  const hook = program
    .command("hook")
    .description("Claude Code hook handlers (internal)")
    .helpOption(false);

  // Plugin managers are intentionally not loaded in hook subprocesses.
  // Hooks must stay fast and stateless, so plugin-specific hooks fire only
  // from the main CLI process where the PluginManager is initialized.

  hook.command("post-tool-use").action(async () => {
    const projectRoot = resolveHookProjectRoot();
    if (!projectRoot) return;
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;
    configureHookWebhooks(projectRoot);
    initHookTelemetry(projectRoot);

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    const toolName = (data.tool_name as string) ?? "unknown";
    const toolInput = data.tool_input as Record<string, unknown> | undefined;
    const WRITE_TOOLS = new Set(["Write", "Edit", "Bash", "MultiEdit"]);
    const isWriteOp = WRITE_TOOLS.has(toolName);
    // Claude Code sends tool output as "tool_response".
    const toolResponse = data.tool_response ?? data.tool_result ?? data.result;

    // Skip Claude Code internal meta-tools (task tracking, etc.).
    // These add noise and have no governance value.
    const INTERNAL_TOOLS = new Set([
      "TaskCreate", "TaskUpdate", "TaskDone", "TaskDelete",
      "TodoRead", "TodoWrite",
    ]);
    if (INTERNAL_TOOLS.has(toolName)) return;

    const filesAffected: string[] = [];
    if (toolInput && typeof toolInput === "object") {
      for (const key of ["file_path", "path", "filename"]) {
        if (key in toolInput) filesAffected.push(String(toolInput[key]));
      }
    }
    if (toolName === "Bash" && toolInput && typeof toolInput.command === "string") {
      const fromBash = extractPathsFromBashCommand(toolInput.command);
      for (const p of fromBash) {
        if (p && !filesAffected.includes(p)) filesAffected.push(p);
      }
    }

    let action = `tool_use: ${toolName}`;
    if (toolName === "Bash" && toolInput) {
      const cmd = String(toolInput.command ?? "").slice(0, 120);
      action = `tool_use: bash — ${cmd}`;
    } else if (
      (toolName === "Edit" || toolName === "Write") &&
      filesAffected.length
    ) {
      action = `tool_use: ${toolName.toLowerCase()} — ${filesAffected[0]}`;
    }

    const khoregoDir = path.join(projectRoot, ".khoregos");
    const db = new Db(path.join(khoregoDir, "k6s.db"));
    db.connect();
    try {
      const signingKey = loadSigningKey(khoregoDir);
      const sm = new StateManager(db, projectRoot);
      const currentSession = sm.getSession(sessionId);
      const traceId = currentSession?.traceId ?? null;
      const claudeSessionId = data.session_id as string | undefined;
      let agentId: string | null = null;
      if (claudeSessionId) {
        let agent = sm.getAgentByClaudeSessionId(sessionId, claudeSessionId);
        if (!agent) {
          agent = sm.assignClaudeSessionToNewestUnassignedAgent(
            sessionId,
            claudeSessionId,
          );
        }
        if (agent) agentId = agent.id;
      }
      if (!agentId) {
        // Single-agent sessions don't fire SubagentStart hooks, so no agent
        // is pre-registered. Create one named "primary" on first tool use.
        let fallback = sm.getAgentByName(sessionId, "primary");
        if (!fallback) {
          fallback = sm.registerAgent({
            sessionId,
            name: "primary",
          });
        }
        agentId = fallback.id;
      }

      // Track tool call count for resource limit enforcement.
      const newCount = sm.incrementToolCallCount(agentId);
      const agentObj = sm.getAgent(agentId);
      const agentName = agentObj?.name ?? "unknown";

      // Load config once and reuse for strict boundary and gate checks.
      const configPath = path.join(projectRoot, "k6s.yaml");
      const config = existsSync(configPath)
        ? loadConfigOrDefault(configPath, "project")
        : null;
      const be = config
        ? new BoundaryEnforcer(
            db,
            sessionId,
            projectRoot,
            config.boundaries,
          )
        : null;
      const boundary = be?.getBoundaryForAgent(agentName) ?? null;

      // Check whether this call crosses the configured per-agent limit.
      const limit = boundary?.max_tool_calls_per_session;
      if (limit != null && newCount > limit && newCount === limit + 1) {
        // Log only on first exceedance to avoid audit spam.
        const exceedLogger = new AuditLogger(db, sessionId, traceId, signingKey);
        exceedLogger.start();
        exceedLogger.log({
          eventType: "boundary_violation",
          action: `resource limit exceeded: agent '${agentName}' has made ${newCount} tool calls (limit: ${limit})`,
          agentId,
          details: {
            limit_type: "tool_calls",
            current: newCount,
            limit,
            agent_name: agentName,
          },
          severity: "warning",
        });
        exceedLogger.stop();
      }

      // Strict boundary enforcement: revert out-of-bounds writes post-tool-use.
      if (isWriteOp && filesAffected.length && be && boundary?.enforcement === "strict") {
        for (const fp of filesAffected) {
          const absPath = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
          const [allowed, reason] = be.checkPathAllowed(absPath, agentName);
          if (allowed) continue;

          const originalContent = revertFile(absPath, projectRoot);
          const relativePath = path.isAbsolute(fp)
            ? path.relative(projectRoot, fp)
            : fp;
          const enforcementAction =
            originalContent !== null ? "reverted" : "revert_failed";
          const violationType =
            reason?.includes("forbidden pattern") === true
              ? "forbidden_path"
              : "outside_allowed";

          be.recordViolation({
            filePath: relativePath,
            agentId,
            violationType,
            enforcementAction,
            details: {
              reason,
              original_content: originalContent,
            },
          });

          const revertLogger = new AuditLogger(db, sessionId, traceId, signingKey);
          revertLogger.start();
          revertLogger.log({
            eventType: "boundary_violation",
            action: `strict enforcement: reverted ${relativePath} - ${reason ?? "boundary violation"}`,
            agentId,
            details: {
              enforcement_action: enforcementAction,
              file: relativePath,
              reason: reason ?? null,
              original_content_preview: originalContent?.slice(0, 500) ?? null,
            },
            filesAffected: [relativePath],
            severity: "critical",
          });
          revertLogger.stop();
        }
      }

      const details: Record<string, unknown> = {
        tool_name: toolName,
        tool_input: truncate(toolInput ?? {}, 2000),
        session_id: data.session_id,
        tool_use_id: data.tool_use_id,
      };
      const durationMs = extractDurationMs(data);
      if (durationMs != null && durationMs >= 0) {
        details.duration_ms = durationMs;
      }
      const toolOutputStr =
        toolResponse != null
          ? typeof toolResponse === "string"
            ? toolResponse
            : JSON.stringify(toolResponse)
          : "";
      if (toolOutputStr) {
        details.tool_output =
          toolOutputStr.length > 2000
            ? toolOutputStr.slice(0, 2000) + "...[truncated]"
            : toolOutputStr;
      }

      const severity = classifySeverity({
        eventType: "tool_use",
        action,
        filesAffected: filesAffected.length ? filesAffected : undefined,
      });

      const logger = new AuditLogger(db, sessionId, traceId, signingKey);
      logger.start();
      const event = logger.log({
        eventType: "tool_use",
        action,
        agentId,
        details,
        filesAffected: filesAffected.length ? filesAffected : undefined,
        severity,
      });
      logger.stop();

      const tracer = getTracer();
      tracer.startActiveSpan(
        "tool.use",
        {
          attributes: {
            "tool.name": toolName,
            "agent.name": agentName,
            ...(durationMs != null && { duration_ms: durationMs }),
          },
        },
        (span) => {
          span.end();
        },
      );
      if (durationMs != null && durationMs >= 0) {
        recordToolDurationSeconds(durationMs / 1000);
      }

      // Sensitive-file annotation: log a sensitive_needs_review audit event when
      // write operations touch files matching configured gate patterns.
      // This is a passive audit marker — no interactive workflow.
      if (isWriteOp && filesAffected.length && config) {
        const matcher = new ReviewPatternMatcher(config.gates ?? []);
        for (const fp of filesAffected) {
          const relative = path.isAbsolute(fp)
            ? path.relative(projectRoot, fp)
            : fp;
          const ruleIds = matcher.matchingRules(relative);
          for (const ruleId of ruleIds) {
            const ruleConfig = config.gates?.find((g) => g.id === ruleId);
            const ruleName = ruleConfig?.name ?? ruleId;
            logger.start();
            logger.log({
              eventType: "gate_triggered",
              action: `Sensitive file modified: ${ruleName} — ${relative}`,
              agentId,
              details: {
                rule_id: ruleId,
                file: relative,
                trigger_event_id: event.id,
              },
              filesAffected: [relative],
              severity: "warning",
            });
            logger.stop();
          }
        }
      }

      // Dependency change detection: when package.json is modified,
      // diff against the last committed version and log granular events.
      if (filesAffected.length) {
        const depFiles = filesAffected.filter((fp) => path.basename(fp) === "package.json");
        for (const depFile of depFiles) {
          const absPath = path.isAbsolute(depFile) ? depFile : path.join(projectRoot, depFile);
          const changes = detectDependencyChanges(absPath, projectRoot);
          for (const change of changes) {
            const eventType: EventType =
              change.type === "added"
                ? "dependency_added"
                : change.type === "removed"
                  ? "dependency_removed"
                  : "dependency_updated";
            const versionInfo =
              change.type === "updated"
                ? `${change.oldVersion} → ${change.newVersion}`
                : change.type === "added"
                  ? change.newVersion ?? ""
                  : change.oldVersion ?? "";
            logger.start();
            logger.log({
              eventType,
              action: `dependency ${change.type}: ${change.name} ${versionInfo}`.trim(),
              agentId,
              details: {
                name: change.name,
                old_version: change.oldVersion ?? null,
                new_version: change.newVersion ?? null,
                file: depFile,
              },
              filesAffected: [depFile],
              severity: "warning",
            });
            logger.stop();
          }
        }
      }

    } finally {
      db.close();
      await shutdownTelemetry();
    }
  });

  hook.command("subagent-start").action(async () => {
    const projectRoot = resolveHookProjectRoot();
    if (!projectRoot) return;
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;
    configureHookWebhooks(projectRoot);
    initHookTelemetry(projectRoot);

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    const agentName =
      (data.tool_name as string) ??
      (typeof data.tool_input === "object" && data.tool_input !== null && "name" in (data.tool_input as object)
        ? String((data.tool_input as Record<string, unknown>).name)
        : "subagent");

    const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
    db.connect();
    try {
      const sm = new StateManager(db, projectRoot);
      const agent = sm.registerAgent({
        sessionId,
        name: agentName,
      });
      logEvent({
        projectRoot,
        sessionId,
        eventType: "agent_spawn",
        action: `agent spawned: ${agentName}`,
        details: {
          tool_name: data.tool_name,
          tool_input: truncate(data.tool_input ?? {}, 2000),
          session_id: data.session_id,
        },
        agentId: agent.id,
      });
      const tracer = getTracer();
      tracer.startActiveSpan(
        "agent.spawn",
        { attributes: { "agent.name": agentName } },
        (span) => {
          span.end();
        },
      );
      recordActiveAgentDelta(1);
    } finally {
      db.close();
      await shutdownTelemetry();
    }
  });

  hook.command("subagent-stop").action(async () => {
    const projectRoot = resolveHookProjectRoot();
    if (!projectRoot) return;
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;
    configureHookWebhooks(projectRoot);
    initHookTelemetry(projectRoot);

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    // Resolve agent identity from Claude Code session ID.
    const stopKhoregoDir = path.join(projectRoot, ".khoregos");
    const db = new Db(path.join(stopKhoregoDir, "k6s.db"));
    db.connect();
    try {
      const stopKey = loadSigningKey(stopKhoregoDir);
      const sm = new StateManager(db, projectRoot);
      const stopSession = sm.getSession(sessionId);
      const stopTraceId = stopSession?.traceId ?? null;
      let agentId: string | null = null;
      const claudeSessionId = data.session_id as string | undefined;
      if (claudeSessionId) {
        const agent = sm.getAgentByClaudeSessionId(sessionId, claudeSessionId);
        if (agent) {
          agentId = agent.id;
          agent.state = "completed";
          sm.updateAgent(agent);
        }
      }

      const logger = new AuditLogger(db, sessionId, stopTraceId, stopKey);
      logger.start();
      logger.log({
        eventType: "agent_complete",
        action: `agent completed: ${data.tool_name ?? "subagent"}`,
        agentId,
        details: {
          tool_name: data.tool_name,
          session_id: data.session_id,
        },
      });
      logger.stop();
      const tracer = getTracer();
      tracer.startActiveSpan("agent.stop", (span) => {
        span.end();
      });
      recordActiveAgentDelta(-1);
    } finally {
      db.close();
      await shutdownTelemetry();
    }
  });

  hook.command("session-stop").action(() => {
    const projectRoot = resolveHookProjectRoot();
    if (!projectRoot) return;
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;
    configureHookWebhooks(projectRoot);

    const data = readHookInput();

    // Check whether the k6s session should end when Claude exits.
    const configPath = path.join(projectRoot, "k6s.yaml");
    const config = loadConfigOrDefault(configPath, "project");
    if (!config.session.end_on_claude_exit) {
      logEvent({
        projectRoot,
        sessionId,
        eventType: "session_complete",
        action: "claude code session ended (k6s session kept alive)",
        details: { session_id: data.session_id, end_on_claude_exit: false },
        severity: "info",
      });
      return;
    }

    logEvent({
      projectRoot,
      sessionId,
      eventType: "session_complete",
      action: "claude code session ended",
      details: { session_id: data.session_id },
    });

    // Mark session as completed.
    const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
    db.connect();
    try {
      const state = new StateManager(db, projectRoot);
      state.markSessionCompleted(sessionId);
    } finally {
      db.close();
    }

    // Remove daemon state.
    const daemonState = new DaemonState(path.join(projectRoot, ".khoregos"));
    daemonState.removeState();
  });
}
