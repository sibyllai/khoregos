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

import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DaemonState } from "../daemon/manager.js";
import { AuditLogger } from "../engine/audit.js";
import { StateManager } from "../engine/state.js";
import { Db } from "../store/db.js";
import type { EventType } from "../models/audit.js";

function readHookInput(): Record<string, unknown> {
  try {
    const raw = readFileSync(0, "utf-8"); // stdin = fd 0
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

function logEvent(opts: {
  projectRoot: string;
  sessionId: string;
  eventType: EventType;
  action: string;
  details?: Record<string, unknown>;
  agentId?: string | null;
  filesAffected?: string[];
}): void {
  const db = new Db(path.join(opts.projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    const logger = new AuditLogger(db, opts.sessionId);
    logger.start();
    logger.log({
      eventType: opts.eventType,
      action: opts.action,
      agentId: opts.agentId,
      details: opts.details,
      filesAffected: opts.filesAffected,
    });
    logger.stop();
  } finally {
    db.close();
  }
}

function truncate(obj: unknown, maxLen = 2000): unknown {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length > maxLen) return s.slice(0, maxLen) + "...[truncated]";
  return obj;
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

    const filesAffected: string[] = [];
    if (toolInput && typeof toolInput === "object") {
      for (const key of ["file_path", "path", "filename"]) {
        if (key in toolInput) filesAffected.push(String(toolInput[key]));
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

    logEvent({
      projectRoot,
      sessionId,
      eventType: "tool_use",
      action,
      details: {
        tool_name: toolName,
        tool_input: truncate(toolInput ?? {}, 2000),
        session_id: data.session_id,
        tool_use_id: data.tool_use_id,
      },
      filesAffected,
    });
  });

  hook.command("subagent-start").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    logEvent({
      projectRoot,
      sessionId,
      eventType: "agent_spawn",
      action: `agent spawned: ${data.tool_name ?? "subagent"}`,
      details: {
        tool_name: data.tool_name,
        tool_input: truncate(data.tool_input ?? {}, 2000),
        session_id: data.session_id,
      },
    });
  });

  hook.command("subagent-stop").action(() => {
    const projectRoot = process.cwd();
    const sessionId = getSessionId(projectRoot);
    if (!sessionId) return;

    const data = readHookInput();
    if (!Object.keys(data).length) return;

    logEvent({
      projectRoot,
      sessionId,
      eventType: "agent_complete",
      action: `agent completed: ${data.tool_name ?? "subagent"}`,
      details: {
        tool_name: data.tool_name,
        session_id: data.session_id,
      },
    });
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
