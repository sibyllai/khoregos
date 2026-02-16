/**
 * MCP server exposing governance tools for Claude Code agents.
 *
 * Primary integration point — agents use MCP tools to interact with
 * governance: logging actions, requesting locks, saving/loading
 * persistent context.
 */

import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Db } from "../store/db.js";
import type { K6sConfig } from "../models/config.js";
import { EventType } from "../models/audit.js";
import { AuditLogger } from "../engine/audit.js";
import { loadSigningKey } from "../engine/signing.js";
import { BoundaryEnforcer } from "../engine/boundaries.js";
import { FileLockManager, lockResultToDict } from "../engine/locks.js";
import { StateManager } from "../engine/state.js";
import { VERSION } from "../version.js";

// Event types that agents are allowed to submit via k6s_log.
// System-level types (session lifecycle, gate_triggered, boundary_violation,
// lock events, tool_use, system) are reserved for internal use only.
const AGENT_EVENT_TYPES = [
  "log",
  "file_create",
  "file_modify",
  "file_delete",
  "task_create",
  "task_update",
  "task_complete",
] as const satisfies readonly EventType[];

const INPUT_LIMITS = {
  action: 500,
  key: 500,
  path: 1000,
  agent_name: 200,
  task_id: 200,
  status: 100,
  progress: 2000,
  event_type: 100,
  value_bytes: 65536,
  details_bytes: 32768,
  files_max: 100,
  duration_seconds_max: 3600,
} as const;

function validateInput(
  args: Record<string, unknown>,
): string | null {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const limit = INPUT_LIMITS[key as keyof typeof INPUT_LIMITS] as
        | number
        | undefined;
      if (limit && value.length > limit) {
        return `Input '${key}' exceeds maximum length of ${limit} characters`;
      }
    }
    if (key === "details" && typeof value === "object" && value !== null) {
      const serialized = JSON.stringify(value);
      if (serialized.length > INPUT_LIMITS.details_bytes) {
        return `'details' exceeds maximum size of ${INPUT_LIMITS.details_bytes} bytes`;
      }
    }
    if (key === "value") {
      const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
      if (serialized.length > INPUT_LIMITS.value_bytes) {
        return `'value' exceeds maximum size of ${INPUT_LIMITS.value_bytes} bytes`;
      }
    }
    if (key === "files" && Array.isArray(value)) {
      if (value.length > INPUT_LIMITS.files_max) {
        return `'files' list exceeds maximum of ${INPUT_LIMITS.files_max} entries`;
      }
    }
    if (key === "duration_seconds" && typeof value === "number") {
      if (value <= 0 || value > INPUT_LIMITS.duration_seconds_max) {
        return `'duration_seconds' must be between 1 and ${INPUT_LIMITS.duration_seconds_max}`;
      }
    }
  }
  return null;
}

export class K6sServer {
  private mcp: McpServer;
  private auditLogger: AuditLogger;
  private stateManager: StateManager;
  private boundaryEnforcer: BoundaryEnforcer;
  private lockManager: FileLockManager;

  constructor(
    private db: Db,
    private config: K6sConfig,
    private sessionId: string,
    private projectRoot: string,
  ) {
    const khoregoDir = path.join(projectRoot, ".khoregos");
    const signingKey = loadSigningKey(khoregoDir);
    // Resolve trace_id from the session for injection into audit events.
    const sm = new StateManager(db, projectRoot);
    const session = sm.getSession(sessionId);
    this.auditLogger = new AuditLogger(db, sessionId, session?.traceId, signingKey);
    this.stateManager = sm;
    this.boundaryEnforcer = new BoundaryEnforcer(
      db,
      sessionId,
      projectRoot,
      config.boundaries,
    );
    this.lockManager = new FileLockManager(db, sessionId);

    this.mcp = new McpServer(
      { name: "khoregos", version: VERSION },
      { capabilities: { resources: {}, tools: {} } },
    );

    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    // -- Audit logging.
    this.mcp.registerTool(
      "k6s_log",
      {
        description: "Log an action to the audit trail. Call this before and after significant actions.",
        inputSchema: {
          action: z.string().describe("Human-readable description of the action"),
          event_type: z.enum(AGENT_EVENT_TYPES).optional().describe("Type of event (log, file_create, file_modify, file_delete, task_create, task_update, task_complete)"),
          agent_name: z.string().optional().describe("Name of the agent performing the action"),
          details: z.record(z.unknown()).optional().describe("Additional structured details"),
          files: z.array(z.string()).optional().describe("List of files affected by this action"),
        },
      },
      async (args) => {
        const err = validateInput(args as Record<string, unknown>);
        if (err) return { content: [{ type: "text", text: JSON.stringify({ error: err }) }] };

        let agentId: string | null = null;
        if (args.agent_name) {
          const agent = this.stateManager.getAgentByName(this.sessionId, args.agent_name);
          if (agent) agentId = agent.id;
        }

        // Zod validates the enum at schema level, but belt-and-suspenders:
        // fall back to "log" if something unexpected slips through.
        const allowedSet: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);
        const eventType: EventType = allowedSet.has(args.event_type ?? "")
          ? (args.event_type as EventType)
          : "log";

        const event = this.auditLogger.log({
          eventType,
          action: args.action,
          agentId,
          details: args.details as Record<string, unknown> | undefined,
          filesAffected: args.files,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ status: "logged", event_id: event.id, sequence: event.sequence }) }],
        };
      },
    );

    // -- Persistent context.
    this.mcp.registerTool(
      "k6s_save_context",
      {
        description: "Save persistent context that survives session restarts.",
        inputSchema: {
          key: z.string().describe("Unique key for this context entry"),
          value: z.string().describe("Value to save (JSON string)"),
          agent_name: z.string().optional().describe("Name of the agent saving context"),
        },
      },
      async (args) => {
        const err = validateInput(args as Record<string, unknown>);
        if (err) return { content: [{ type: "text", text: JSON.stringify({ error: err }) }] };

        let agentId: string | null = null;
        if (args.agent_name) {
          const agent = this.stateManager.getAgentByName(this.sessionId, args.agent_name);
          if (agent) agentId = agent.id;
        }

        const entry = this.stateManager.saveContext({
          sessionId: this.sessionId,
          key: args.key,
          value: args.value,
          agentId,
        });

        this.auditLogger.log({
          eventType: "context_saved",
          action: `Saved context: ${args.key}`,
          agentId,
          details: { key: args.key },
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ status: "saved", key: args.key, updated_at: entry.updatedAt }) }],
        };
      },
    );

    this.mcp.registerTool(
      "k6s_load_context",
      {
        description: "Load previously saved context.",
        inputSchema: {
          key: z.string().describe("Key of the context entry to load"),
        },
      },
      async (args) => {
        const entry = this.stateManager.loadContext(this.sessionId, args.key);
        if (!entry) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", key: args.key }) }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "found", key: args.key, value: entry.value, updated_at: entry.updatedAt }) }],
        };
      },
    );

    // -- File locks.
    this.mcp.registerTool(
      "k6s_acquire_lock",
      {
        description: "Acquire an exclusive lock on a file to prevent conflicts.",
        inputSchema: {
          path: z.string().describe("Path to the file to lock"),
          agent_name: z.string().describe("Name of the agent requesting the lock"),
          duration_seconds: z.number().optional().describe("Lock duration in seconds (default: 300)"),
        },
      },
      async (args) => {
        const err = validateInput(args as Record<string, unknown>);
        if (err) return { content: [{ type: "text", text: JSON.stringify({ error: err }) }] };

        let agent = this.stateManager.getAgentByName(this.sessionId, args.agent_name);
        if (!agent) {
          agent = this.stateManager.registerAgent({ sessionId: this.sessionId, name: args.agent_name });
        }

        const [allowed, reason] = this.boundaryEnforcer.checkPathAllowed(args.path, args.agent_name);
        if (!allowed) {
          this.boundaryEnforcer.recordViolation({
            filePath: args.path,
            agentId: agent.id,
            violationType: "forbidden_path",
            enforcementAction: "blocked",
            details: { reason, operation: "lock_acquire" },
          });
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: `Boundary violation: ${reason}` }) }] };
        }

        const result = this.lockManager.acquire(args.path, agent.id, args.duration_seconds);
        if (result.success) {
          this.auditLogger.log({
            eventType: "lock_acquired",
            action: `Lock acquired: ${args.path}`,
            agentId: agent.id,
            filesAffected: [args.path],
          });
        }

        return { content: [{ type: "text", text: JSON.stringify(lockResultToDict(result)) }] };
      },
    );

    this.mcp.registerTool(
      "k6s_release_lock",
      {
        description: "Release a file lock.",
        inputSchema: {
          path: z.string().describe("Path to the file to unlock"),
          agent_name: z.string().describe("Name of the agent releasing the lock"),
        },
      },
      async (args) => {
        const err = validateInput(args as Record<string, unknown>);
        if (err) return { content: [{ type: "text", text: JSON.stringify({ error: err }) }] };

        const agent = this.stateManager.getAgentByName(this.sessionId, args.agent_name);
        const agentId = agent?.id ?? "unknown";

        const [allowed, reason] = this.boundaryEnforcer.checkPathAllowed(args.path, args.agent_name);
        if (!allowed) {
          this.boundaryEnforcer.recordViolation({
            filePath: args.path,
            agentId,
            violationType: "forbidden_path",
            enforcementAction: "blocked",
            details: { reason, operation: "lock_release" },
          });
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: `Boundary violation: ${reason}` }) }] };
        }

        const result = this.lockManager.release(args.path, agentId);
        if (result.success) {
          this.auditLogger.log({
            eventType: "lock_released",
            action: `Lock released: ${args.path}`,
            agentId,
            filesAffected: [args.path],
          });
        }

        return { content: [{ type: "text", text: JSON.stringify(lockResultToDict(result)) }] };
      },
    );

    // -- Boundaries.
    this.mcp.registerTool(
      "k6s_get_boundaries",
      {
        description: "Get the boundary rules for an agent (allowed/forbidden paths).",
        inputSchema: {
          agent_name: z.string().describe("Name of the agent to get boundaries for"),
        },
      },
      async (args) => {
        const summary = this.boundaryEnforcer.getAgentBoundariesSummary(args.agent_name);
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      },
    );

    this.mcp.registerTool(
      "k6s_check_path",
      {
        description: "Check if an agent is allowed to access a file path.",
        inputSchema: {
          path: z.string().describe("Path to check"),
          agent_name: z.string().describe("Name of the agent"),
        },
      },
      async (args) => {
        const [allowed, reason] = this.boundaryEnforcer.checkPathAllowed(args.path, args.agent_name);
        const result: Record<string, unknown> = { path: args.path, agent: args.agent_name, allowed };
        if (reason) result.reason = reason;
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );

    // -- Task tracking.
    this.mcp.registerTool(
      "k6s_task_update",
      {
        description: "Update task state and progress.",
        inputSchema: {
          task_id: z.string().describe("Unique identifier for the task"),
          status: z.string().describe("Task status (pending, in_progress, completed, failed)"),
          progress: z.string().optional().describe("Progress description"),
          agent_name: z.string().optional().describe("Name of the agent updating the task"),
        },
      },
      async (args) => {
        const err = validateInput(args as Record<string, unknown>);
        if (err) return { content: [{ type: "text", text: JSON.stringify({ error: err }) }] };

        let agentId: string | null = null;
        if (args.agent_name) {
          const agent = this.stateManager.getAgentByName(this.sessionId, args.agent_name);
          if (agent) agentId = agent.id;
        }

        this.auditLogger.log({
          eventType: "task_update",
          action: `Task ${args.task_id}: ${args.status}`,
          agentId,
          details: { task_id: args.task_id, status: args.status, progress: args.progress ?? "" },
        });

        return { content: [{ type: "text", text: JSON.stringify({ status: "updated", task_id: args.task_id }) }] };
      },
    );

  }

  private registerResources(): void {
    this.mcp.resource(
      "Current Session",
      "k6s://session/current",
      { description: "Current session metadata", mimeType: "application/json" },
      async () => {
        const session = this.stateManager.getSession(this.sessionId);
        return {
          contents: [{
            uri: "k6s://session/current",
            mimeType: "application/json",
            text: session ? JSON.stringify(session) : JSON.stringify({ error: "No active session" }),
          }],
        };
      },
    );

    this.mcp.resource(
      "Recent Audit Events",
      "k6s://audit/recent",
      { description: "Last 50 audit events", mimeType: "application/json" },
      async () => {
        const events = this.auditLogger.getEvents({ limit: 50 });
        return {
          contents: [{
            uri: "k6s://audit/recent",
            mimeType: "application/json",
            text: JSON.stringify(events),
          }],
        };
      },
    );

    this.mcp.resource(
      "Boundary Rules",
      "k6s://boundaries/all",
      { description: "All configured boundary rules", mimeType: "application/json" },
      async () => {
        return {
          contents: [{
            uri: "k6s://boundaries/all",
            mimeType: "application/json",
            text: JSON.stringify(this.config.boundaries),
          }],
        };
      },
    );
  }

  start(): void {
    this.auditLogger.start();
  }

  stop(): void {
    this.auditLogger.stop();
  }

  async runStdio(): Promise<void> {
    this.start();
    try {
      const transport = new StdioServerTransport();
      await this.mcp.connect(transport);
    } finally {
      this.stop();
    }
  }
}
