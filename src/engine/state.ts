/**
 * State manager for persisting session state.
 */

import { randomUUID } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "../store/db.js";
import {
  type Session,
  type SessionState,
  sessionFromDbRow,
  sessionToDbRow,
} from "../models/session.js";
import {
  type Agent,
  agentFromDbRow,
  agentToDbRow,
} from "../models/agent.js";
import {
  type ContextEntry,
  contextEntryFromDbRow,
  contextEntryToDbRow,
} from "../models/context.js";

export class StateManager {
  constructor(
    private db: Db,
    private projectRoot: string,
  ) {}

  // Session management

  createSession(opts: {
    objective: string;
    configSnapshot?: string | null;
    parentSessionId?: string | null;
  }): Session {
    const session: Session = {
      id: ulid(),
      objective: opts.objective,
      state: "created",
      startedAt: new Date().toISOString(),
      endedAt: null,
      parentSessionId: opts.parentSessionId ?? null,
      configSnapshot: opts.configSnapshot ?? null,
      contextSummary: null,
      metadata: null,
      operator: null,
      hostname: null,
      k6sVersion: null,
      claudeCodeVersion: null,
      gitBranch: null,
      gitSha: null,
      gitDirty: false,
      traceId: randomUUID(),
    };
    this.db.insert("sessions", sessionToDbRow(session));
    return session;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.fetchOne("SELECT * FROM sessions WHERE id = ?", [
      sessionId,
    ]);
    return row ? sessionFromDbRow(row) : null;
  }

  getLatestSession(): Session | null {
    const row = this.db.fetchOne(
      "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1",
    );
    return row ? sessionFromDbRow(row) : null;
  }

  getActiveSession(): Session | null {
    const row = this.db.fetchOne(
      "SELECT * FROM sessions WHERE state IN ('created', 'active') ORDER BY started_at DESC LIMIT 1",
    );
    return row ? sessionFromDbRow(row) : null;
  }

  listSessions(opts?: {
    limit?: number;
    offset?: number;
    state?: SessionState;
  }): Session[] {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;

    if (opts?.state) {
      return this.db
        .fetchAll(
          "SELECT * FROM sessions WHERE state = ? ORDER BY started_at DESC LIMIT ? OFFSET ?",
          [opts.state, limit, offset],
        )
        .map(sessionFromDbRow);
    }
    return this.db
      .fetchAll(
        "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
        [limit, offset],
      )
      .map(sessionFromDbRow);
  }

  updateSession(session: Session): void {
    this.db.update("sessions", sessionToDbRow(session), "id = ?", [session.id]);
  }

  markSessionActive(sessionId: string): void {
    this.db.update("sessions", { state: "active" }, "id = ?", [sessionId]);
  }

  markSessionPaused(sessionId: string): void {
    this.db.update("sessions", { state: "paused" }, "id = ?", [sessionId]);
  }

  markSessionCompleted(sessionId: string, summary?: string): void {
    const data: Record<string, unknown> = {
      state: "completed",
      ended_at: new Date().toISOString(),
    };
    if (summary) data.context_summary = summary;
    this.db.update("sessions", data, "id = ?", [sessionId]);
  }

  // Agent management

  registerAgent(opts: {
    sessionId: string;
    name: string;
    role?: string;
    specialization?: string | null;
    boundaryConfig?: Record<string, unknown> | null;
  }): Agent {
    const agent: Agent = {
      id: ulid(),
      sessionId: opts.sessionId,
      name: opts.name,
      role: (opts.role as Agent["role"]) ?? "teammate",
      specialization: opts.specialization ?? null,
      state: "active",
      spawnedAt: new Date().toISOString(),
      boundaryConfig: opts.boundaryConfig
        ? JSON.stringify(opts.boundaryConfig)
        : null,
      metadata: null,
      claudeSessionId: null,
      toolCallCount: 0,
    };
    this.db.insert("agents", agentToDbRow(agent));
    return agent;
  }

  getAgent(agentId: string): Agent | null {
    const row = this.db.fetchOne("SELECT * FROM agents WHERE id = ?", [
      agentId,
    ]);
    return row ? agentFromDbRow(row) : null;
  }

  getAgentByName(sessionId: string, name: string): Agent | null {
    const row = this.db.fetchOne(
      "SELECT * FROM agents WHERE session_id = ? AND name = ?",
      [sessionId, name],
    );
    return row ? agentFromDbRow(row) : null;
  }

  getAgentByClaudeSessionId(
    sessionId: string,
    claudeSessionId: string,
  ): Agent | null {
    const row = this.db.fetchOne(
      "SELECT * FROM agents WHERE session_id = ? AND claude_session_id = ?",
      [sessionId, claudeSessionId],
    );
    return row ? agentFromDbRow(row) : null;
  }

  assignClaudeSessionToNewestUnassignedAgent(
    sessionId: string,
    claudeSessionId: string,
  ): Agent | null {
    const row = this.db.fetchOne(
      "SELECT * FROM agents WHERE session_id = ? AND (claude_session_id IS NULL OR claude_session_id = '') ORDER BY spawned_at DESC LIMIT 1",
      [sessionId],
    );
    if (!row) return null;
    const agent = agentFromDbRow(row);
    agent.claudeSessionId = claudeSessionId;
    this.db.update(
      "agents",
      { claude_session_id: claudeSessionId },
      "id = ?",
      [agent.id],
    );
    return agent;
  }

  listAgents(sessionId: string): Agent[] {
    return this.db
      .fetchAll(
        "SELECT * FROM agents WHERE session_id = ? ORDER BY spawned_at",
        [sessionId],
      )
      .map(agentFromDbRow);
  }

  updateAgent(agent: Agent): void {
    this.db.update("agents", agentToDbRow(agent), "id = ?", [agent.id]);
  }

  incrementToolCallCount(agentId: string): number {
    this.db.db
      .prepare("UPDATE agents SET tool_call_count = tool_call_count + 1 WHERE id = ?")
      .run(agentId);
    const row = this.db.fetchOne(
      "SELECT tool_call_count FROM agents WHERE id = ?",
      [agentId],
    );
    return (row?.tool_call_count as number) ?? 0;
  }

  // Context management

  saveContext(opts: {
    sessionId: string;
    key: string;
    value: string;
    agentId?: string | null;
  }): ContextEntry {
    const entry: ContextEntry = {
      key: opts.key,
      sessionId: opts.sessionId,
      agentId: opts.agentId ?? null,
      value: opts.value,
      updatedAt: new Date().toISOString(),
    };
    this.db.insertOrReplace("context_store", contextEntryToDbRow(entry));
    return entry;
  }

  loadContext(sessionId: string, key: string): ContextEntry | null {
    const row = this.db.fetchOne(
      "SELECT * FROM context_store WHERE session_id = ? AND key = ?",
      [sessionId, key],
    );
    return row ? contextEntryFromDbRow(row) : null;
  }

  loadAllContext(sessionId: string, agentId?: string): ContextEntry[] {
    if (agentId) {
      return this.db
        .fetchAll(
          "SELECT * FROM context_store WHERE session_id = ? AND agent_id = ? ORDER BY key",
          [sessionId, agentId],
        )
        .map(contextEntryFromDbRow);
    }
    return this.db
      .fetchAll(
        "SELECT * FROM context_store WHERE session_id = ? ORDER BY key",
        [sessionId],
      )
      .map(contextEntryFromDbRow);
  }

  deleteContext(sessionId: string, key: string): void {
    this.db.delete("context_store", "session_id = ? AND key = ?", [
      sessionId,
      key,
    ]);
  }

  // Session summary for resumption

  generateResumeContext(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) return "";

    const agents = this.listAgents(sessionId);
    const contextEntries = this.loadAllContext(sessionId);

    const lines: string[] = [
      "## Previous Session Context",
      "",
      `**Objective**: ${session.objective}`,
      `**Started**: ${new Date(session.startedAt).toISOString().slice(0, 16).replace("T", " ")}`,
      "",
    ];

    if (session.contextSummary) {
      lines.push("### Session Summary", session.contextSummary, "");
    }

    if (agents.length > 0) {
      lines.push("### Active Agents");
      for (const agent of agents) {
        const spec = agent.specialization ? ` (${agent.specialization})` : "";
        lines.push(`- **${agent.name}**${spec}: ${agent.state}`);
      }
      lines.push("");
    }

    if (contextEntries.length > 0) {
      lines.push("### Saved Context");
      for (const entry of contextEntries.slice(0, 10)) {
        const preview =
          entry.value.length > 100
            ? entry.value.slice(0, 100) + "..."
            : entry.value;
        lines.push(`- **${entry.key}**: ${preview}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
