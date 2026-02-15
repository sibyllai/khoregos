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

import { existsSync, readSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfigOrDefault } from "../models/config.js";
import { DaemonState } from "../daemon/manager.js";
import { AuditLogger } from "../engine/audit.js";
import { StateManager } from "../engine/state.js";
import { classifySeverity, extractPathsFromBashCommand } from "../engine/severity.js";
import { loadSigningKey } from "../engine/signing.js";
import { ReviewPatternMatcher } from "../watcher/fs.js";
import { Db } from "../store/db.js";
import type { EventType } from "../models/audit.js";

// Maximum bytes to read from stdin before aborting (1 MB).
// Hook payloads are small JSON objects; anything larger is anomalous.
const MAX_STDIN_BYTES = 1_048_576;

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
    const logger = new AuditLogger(db, opts.sessionId, null, key);
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

  hook.command("post-tool-use").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    const toolName = (data.tool_name as string) ?? "unknown";
    const toolInput = data.tool_input as Record<string, unknown> | undefined;
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

      const details: Record<string, unknown> = {
        tool_name: toolName,
        tool_input: truncate(toolInput ?? {}, 2000),
        session_id: data.session_id,
        tool_use_id: data.tool_use_id,
      };
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

      const logger = new AuditLogger(db, sessionId, null, signingKey);
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

      // Sensitive-file annotation: log a sensitive_needs_review audit event when
      // write operations touch files matching configured gate patterns.
      // This is a passive audit marker — no interactive workflow.
      const WRITE_TOOLS = new Set(["Write", "Edit", "Bash", "MultiEdit"]);
      const isWriteOp = WRITE_TOOLS.has(toolName);

      const configPath = path.join(projectRoot, "k6s.yaml");
      if (isWriteOp && filesAffected.length && existsSync(configPath)) {
        const config = loadConfigOrDefault(configPath, "project");
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

    } finally {
      db.close();
    }
  });

  hook.command("subagent-start").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

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
    } finally {
      db.close();
    }
  });

  hook.command("subagent-stop").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    // Resolve agent identity from Claude Code session ID.
    const stopKhoregoDir = path.join(projectRoot, ".khoregos");
    const db = new Db(path.join(stopKhoregoDir, "k6s.db"));
    db.connect();
    try {
      const stopKey = loadSigningKey(stopKhoregoDir);
      const sm = new StateManager(db, projectRoot);
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

      const logger = new AuditLogger(db, sessionId, null, stopKey);
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
    } finally {
      db.close();
    }
  });

  hook.command("session-stop").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

    const data = readHookInput();

    logEvent({
      projectRoot,
      sessionId,
      eventType: "session_complete",
      action: "claude code session ended",
      details: { session_id: data.session_id },
    });

    // Mark session as completed
    const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
    db.connect();
    try {
      const state = new StateManager(db, projectRoot);
      state.markSessionCompleted(sessionId);
    } finally {
      db.close();
    }

    // Remove daemon state
    const daemonState = new DaemonState(path.join(projectRoot, ".khoregos"));
    daemonState.removeState();
  });
}
