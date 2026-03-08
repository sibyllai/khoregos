/**
 * Built-in HTTP server for the real-time audit dashboard.
 *
 * Serves a self-contained HTML dashboard, SSE event stream,
 * and REST API endpoints backed by the same SQLite database
 * that hooks and the MCP server write to.
 */

import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Db } from "../store/db.js";
import type { K6sConfig } from "../models/config.js";
import { getDashboardHTML } from "./dashboard-template.js";
import { generateAuditReport, type ReportStandard } from "./report.js";
import { AuditLogger } from "./audit.js";
import { StateManager } from "./state.js";
import { loadSigningKey, verifyChain, type VerifyError } from "./signing.js";

export interface DashboardServerOptions {
  db: Db;
  config: K6sConfig;
  sessionId: string;
  port: number;
  host: string;
  projectRoot?: string;
}

/** Hosts that are safe to bind without explicit opt-in. */
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

interface SSEClient {
  res: ServerResponse;
  id: number;
}

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Map<number, SSEClient> = new Map();
  private clientIdCounter = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastAuditRowId = 0;
  private lastCostRowId = 0;
  private seenEventIds: Set<string> = new Set();
  private readonly SEEN_SET_MAX = 10_000;

  /** Bearer token required for the /api/push endpoint. */
  readonly pushToken: string;

  constructor(private opts: DashboardServerOptions) {
    // Use token from env (set by team.ts daemon launcher) or generate a new one.
    this.pushToken = process.env.K6S_DASHBOARD_PUSH_TOKEN || randomBytes(24).toString("hex");
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  set sessionId(id: string) {
    this.opts.sessionId = id;
  }

  async start(): Promise<number> {
    const { db, config, port, host } = this.opts;

    if (!SAFE_HOSTS.has(host) && host !== "0.0.0.0" && host !== "::") {
      // Unknown host string — allow it (could be a hostname resolving to loopback).
    }
    if (host === "0.0.0.0" || host === "::") {
      throw new Error(
        `Refusing to bind dashboard to "${host}" — this would expose the unauthenticated ` +
          "dashboard to the network. Use --host localhost (default) or a specific interface.",
      );
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        const addr = this.server!.address() as AddressInfo;

        // Start heartbeat for SSE clients (15s).
        this.heartbeatInterval = setInterval(() => {
          this.broadcast(": heartbeat\n\n");
        }, 15_000);

        // Poll SQLite for new rows every 2s.
        this.pollInterval = setInterval(() => {
          this.pollNewRows();
        }, 2_000);

        resolve(addr.port);
      });

      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Close all SSE clients.
    for (const [, client] of this.clients) {
      client.res.end();
    }
    this.clients.clear();

    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Push an event from hooks (bypasses polling). */
  pushEvent(event: Record<string, unknown>): void {
    const eventId = String(event.id ?? "");
    if (eventId && this.seenEventIds.has(eventId)) return;
    if (eventId) this.addToSeenSet(eventId);

    const data = JSON.stringify(event);
    const ssePayload = eventId
      ? `id: ${eventId}\nevent: audit\ndata: ${data}\n\n`
      : `event: audit\ndata: ${data}\n\n`;
    this.broadcast(ssePayload);
  }

  private addToSeenSet(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > this.SEEN_SET_MAX) {
      // Prune oldest half.
      const entries = [...this.seenEventIds];
      this.seenEventIds = new Set(entries.slice(entries.length / 2));
    }
  }

  private broadcast(payload: string): void {
    const dead: number[] = [];
    for (const [id, client] of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        dead.push(id);
      }
    }
    for (const id of dead) {
      this.clients.delete(id);
    }
  }

  private pollNewRows(): void {
    const { db } = this.opts;
    const sessionId = this.opts.sessionId;

    try {
      const rows = db.fetchAll(
        `SELECT rowid, id, sequence, session_id, agent_id, timestamp,
                event_type, action, details, files_affected, severity
         FROM audit_events
         WHERE session_id = ? AND rowid > ?
         ORDER BY rowid ASC
         LIMIT 200`,
        [sessionId, this.lastAuditRowId],
      );

      for (const row of rows) {
        const rowId = Number(row.rowid ?? 0);
        if (rowId > this.lastAuditRowId) this.lastAuditRowId = rowId;

        const eventId = String(row.id ?? "");
        if (eventId && this.seenEventIds.has(eventId)) continue;
        if (eventId) this.addToSeenSet(eventId);

        const event = this.rowToEvent(row);
        const data = JSON.stringify(event);
        this.broadcast(`id: ${eventId}\nevent: audit\ndata: ${data}\n\n`);
      }

      // Poll cost records too.
      const costRows = db.fetchAll(
        `SELECT rowid, id, session_id, agent_id, timestamp, model,
                input_tokens, output_tokens, estimated_cost_usd
         FROM cost_records
         WHERE session_id = ? AND rowid > ?
         ORDER BY rowid ASC
         LIMIT 200`,
        [sessionId, this.lastCostRowId],
      );

      for (const row of costRows) {
        const rowId = Number(row.rowid ?? 0);
        if (rowId > this.lastCostRowId) this.lastCostRowId = rowId;

        const data = JSON.stringify(row);
        this.broadcast(`event: cost\ndata: ${data}\n\n`);
      }
    } catch {
      // DB might be locked; skip this cycle.
    }
  }

  private rowToEvent(row: Record<string, unknown>): Record<string, unknown> {
    let details: unknown = null;
    if (typeof row.details === "string") {
      try {
        details = JSON.parse(row.details);
      } catch {
        details = row.details;
      }
    }
    let filesAffected: unknown = null;
    if (typeof row.files_affected === "string") {
      try {
        filesAffected = JSON.parse(row.files_affected);
      } catch {
        filesAffected = row.files_affected;
      }
    }
    return {
      id: row.id,
      sequence: row.sequence,
      session_id: row.session_id,
      agent_id: row.agent_id,
      timestamp: row.timestamp,
      event_type: row.event_type,
      action: row.action,
      details,
      files_affected: filesAffected,
      severity: row.severity,
    };
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // No CORS headers — the dashboard is served from the same origin,
    // so cross-origin access is intentionally denied to prevent
    // exfiltration of audit data by malicious websites.

    if (pathname === "/" && req.method === "GET") {
      return this.serveHTML(res);
    }
    if (pathname === "/events" && req.method === "GET") {
      return this.serveSSE(req, res);
    }
    if (pathname === "/api/events" && req.method === "GET") {
      return this.apiEvents(url, res);
    }
    if (pathname === "/api/sessions" && req.method === "GET") {
      return this.apiSessions(res);
    }
    if (pathname === "/api/cost" && req.method === "GET") {
      return this.apiCost(res);
    }
    if (pathname === "/api/agents" && req.method === "GET") {
      return this.apiAgents(res);
    }
    if (pathname === "/api/review" && req.method === "GET") {
      return this.apiReview(res);
    }
    if (pathname === "/api/transcript" && req.method === "GET") {
      return this.apiTranscript(url, res);
    }
    if (pathname === "/api/export/events" && req.method === "GET") {
      return this.apiExportEvents(url, res);
    }
    if (pathname === "/api/export/report" && req.method === "GET") {
      return this.apiExportReport(url, res);
    }
    if (pathname === "/api/push" && req.method === "POST") {
      return this.apiPush(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private serveHTML(res: ServerResponse): void {
    const html = getDashboardHTML(this.opts.sessionId, this.opts.config);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(html);
  }

  private serveSSE(req: IncomingMessage, res: ServerResponse): void {
    const clientId = this.clientIdCounter++;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    this.clients.set(clientId, { res, id: clientId });

    req.on("close", () => {
      this.clients.delete(clientId);
    });
  }

  private apiEvents(url: URL, res: ServerResponse): void {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), 2000);
    // Always scope to the bound session — callers cannot query arbitrary sessions.
    const sessionId = this.opts.sessionId;

    const rows = this.opts.db.fetchAll(
      `SELECT rowid, id, sequence, session_id, agent_id, timestamp,
              event_type, action, details, files_affected, severity
       FROM audit_events
       WHERE session_id = ?
       ORDER BY sequence DESC
       LIMIT ?`,
      [sessionId, limit],
    );

    const events = rows.map((r) => {
      const rowId = Number(r.rowid ?? 0);
      if (rowId > this.lastAuditRowId) this.lastAuditRowId = rowId;
      const eventId = String(r.id ?? "");
      if (eventId) this.addToSeenSet(eventId);
      return this.rowToEvent(r);
    });

    this.jsonResponse(res, { events: events.reverse() });
  }

  private apiSessions(res: ServerResponse): void {
    const rows = this.opts.db.fetchAll(
      `SELECT id, objective, state, started_at, ended_at, operator, git_branch
       FROM sessions
       ORDER BY started_at DESC
       LIMIT 20`,
    );
    this.jsonResponse(res, { sessions: rows });
  }

  private apiCost(res: ServerResponse): void {
    const sessionId = this.opts.sessionId;

    const summary = this.opts.db.fetchOne(
      `SELECT
         COALESCE(SUM(estimated_cost_usd), 0) as total_cost,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COUNT(*) as record_count
       FROM cost_records
       WHERE session_id = ?`,
      [sessionId],
    );

    const byModel = this.opts.db.fetchAll(
      `SELECT model,
              COALESCE(SUM(estimated_cost_usd), 0) as cost,
              COALESCE(SUM(input_tokens), 0) as input_tokens,
              COALESCE(SUM(output_tokens), 0) as output_tokens,
              COUNT(*) as count
       FROM cost_records
       WHERE session_id = ?
       GROUP BY model`,
      [sessionId],
    );

    const byAgent = this.opts.db.fetchAll(
      `SELECT cr.agent_id, a.name as agent_name,
              COALESCE(SUM(cr.estimated_cost_usd), 0) as cost,
              COUNT(*) as count
       FROM cost_records cr
       LEFT JOIN agents a ON cr.agent_id = a.id
       WHERE cr.session_id = ?
       GROUP BY cr.agent_id`,
      [sessionId],
    );

    this.jsonResponse(res, { summary, by_model: byModel, by_agent: byAgent });
  }

  private apiAgents(res: ServerResponse): void {
    const sessionId = this.opts.sessionId;
    const agents = this.opts.db.fetchAll(
      `SELECT id, name, role, specialization, state, spawned_at, tool_call_count
       FROM agents
       WHERE session_id = ?
       ORDER BY spawned_at ASC`,
      [sessionId],
    );
    this.jsonResponse(res, { agents });
  }

  private apiReview(res: ServerResponse): void {
    const sessionId = this.opts.sessionId;
    const rows = this.opts.db.fetchAll(
      `SELECT id, sequence, timestamp, event_type, action, details, files_affected, severity
       FROM audit_events
       WHERE session_id = ? AND event_type IN ('gate_triggered', 'boundary_violation')
       ORDER BY sequence ASC`,
      [sessionId],
    );

    const items = rows.map((r) => this.rowToEvent(r));
    this.jsonResponse(res, { items });
  }

  private apiTranscript(url: URL, res: ServerResponse): void {
    const sessionId = this.opts.sessionId;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 1000);
    const role = url.searchParams.get("role") ?? "";

    let sql = `SELECT id, session_id, agent_id, sequence, entry_type, role, model,
                      content, input_tokens, output_tokens, timestamp, redacted
               FROM transcript_entries
               WHERE session_id = ?`;
    const params: unknown[] = [sessionId];

    if (role) {
      sql += " AND role = ?";
      params.push(role);
    }

    sql += " ORDER BY sequence ASC LIMIT ?";
    params.push(limit);

    try {
      const rows = this.opts.db.fetchAll(sql, params);
      this.jsonResponse(res, { entries: rows });
    } catch {
      // Table might not exist if transcripts are disabled.
      this.jsonResponse(res, { entries: [] });
    }
  }

  private apiExportEvents(url: URL, res: ServerResponse): void {
    const sessionId = this.opts.sessionId;
    const format = url.searchParams.get("format") ?? "json";

    const al = new AuditLogger(this.opts.db, sessionId);
    const events = al.getEvents({ limit: 10000 });

    if (format === "csv") {
      const header = "timestamp,sequence,session_id,agent_id,severity,event_type,action,files_affected";
      const rows = events.map((e) => {
        const files = e.filesAffected
          ? JSON.parse(e.filesAffected).join(";")
          : "";
        const action = String(e.action ?? "").replace(/"/g, '""');
        return [
          e.timestamp, e.sequence, e.sessionId, e.agentId ?? "",
          e.severity ?? "info", e.eventType, `"${action}"`, files,
        ].join(",");
      });
      const csv = [header, ...rows].join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="k6s-events-${sessionId.slice(0, 8)}.csv"`,
      });
      res.end(csv);
      return;
    }

    // Default: JSON
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="k6s-events-${sessionId.slice(0, 8)}.json"`,
    });
    res.end(JSON.stringify(events, null, 2));
  }

  private apiExportReport(url: URL, res: ServerResponse): void {
    const sessionId = this.opts.sessionId;
    const standardParam = url.searchParams.get("standard") ?? "generic";
    const format = url.searchParams.get("format") ?? "markdown";

    const validStandards = ["generic", "soc2", "iso27001"];
    if (!validStandards.includes(standardParam)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "standard must be one of: generic, soc2, iso27001" }));
      return;
    }
    const standard = standardParam as ReportStandard;
    const projectRoot = this.opts.projectRoot ?? process.cwd();

    if (format === "json") {
      const reportData = this.buildReportJson(sessionId, projectRoot);
      if (!reportData) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="k6s-report-${standard}-${sessionId.slice(0, 8)}.json"`,
      });
      res.end(JSON.stringify(reportData, null, 2));
      return;
    }

    // Default: markdown
    const markdown = generateAuditReport(this.opts.db, sessionId, projectRoot, standard);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="k6s-report-${standard}-${sessionId.slice(0, 8)}.md"`,
    });
    res.end(markdown);
  }

  private buildReportJson(sessionId: string, projectRoot: string): Record<string, unknown> | null {
    const db = this.opts.db;
    const sm = new StateManager(db, projectRoot);
    const session = sm.getSession(sessionId);
    if (!session) return null;

    const agents = sm.listAgents(sessionId);
    const logger = new AuditLogger(db, sessionId);
    const eventsDesc = logger.getEvents({ limit: 100000 });
    const events = [...eventsDesc].reverse();

    const khoregoDir = path.join(projectRoot, ".khoregos");
    const signingKey = loadSigningKey(khoregoDir);
    const verification = signingKey
      ? verifyChain(signingKey, sessionId, events)
      : { valid: false, eventsChecked: events.length, errors: [] as VerifyError[] };

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const filesModified = new Set<string>();
    for (const event of events) {
      byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
      if (event.filesAffected) {
        try {
          const files = JSON.parse(event.filesAffected) as string[];
          for (const f of files) filesModified.add(f);
        } catch { /* skip */ }
      }
    }

    const boundaryRows = db.fetchAll(
      "SELECT id, agent_id, file_path, violation_type, enforcement_action, timestamp FROM boundary_violations WHERE session_id = ? ORDER BY timestamp ASC",
      [sessionId],
    );
    const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
    const gateRows = db.fetchAll(
      "SELECT id, gate_id, action, details, timestamp FROM audit_events WHERE session_id = ? AND event_type = 'gate_triggered' ORDER BY sequence ASC",
      [sessionId],
    );

    return {
      session: {
        id: session.id,
        objective: session.objective,
        operator: session.operator,
        hostname: session.hostname,
        git_branch: session.gitBranch,
        git_sha: session.gitSha,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        duration_seconds: session.endedAt
          ? Math.max(0, Math.floor((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000))
          : null,
        trace_id: session.traceId,
        k6s_version: session.k6sVersion,
      },
      agents: agents.map((a) => ({ name: a.name, role: a.role, state: a.state, spawned_at: a.spawnedAt })),
      chain_integrity: {
        result: verification.valid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
        total_events: verification.eventsChecked,
        valid: Math.max(0, verification.eventsChecked - verification.errors.length),
        gaps: verification.errors.filter((e) => e.type === "gap").length,
        mismatches: verification.errors.filter((e) => e.type === "mismatch").length,
      },
      events_summary: { by_type: byType, by_severity: bySeverity },
      files_modified: [...filesModified].sort((a, b) => a.localeCompare(b)),
      boundary_violations: boundaryRows.map((row) => ({
        id: row.id,
        agent_name: row.agent_id ? (agentNameById.get(String(row.agent_id)) ?? null) : null,
        file_path: row.file_path,
        violation_type: row.violation_type,
        enforcement_action: row.enforcement_action,
        timestamp: row.timestamp,
      })),
      gate_events: gateRows.map((row) => {
        let details: Record<string, unknown> = {};
        if (typeof row.details === "string") {
          try { details = JSON.parse(row.details) as Record<string, unknown>; } catch { /* skip */ }
        }
        return {
          id: row.id,
          gate_id: row.gate_id,
          gate_name: typeof details.rule_name === "string" ? details.rule_name : null,
          file_path: typeof details.file === "string" ? details.file : null,
          timestamp: row.timestamp,
        };
      }),
    };
  }

  private apiPush(req: IncomingMessage, res: ServerResponse): void {
    // Require bearer token to prevent event injection from untrusted sources.
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.pushToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 65_536) {
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const event = JSON.parse(body) as Record<string, unknown>;
        this.pushEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
  }

  private jsonResponse(res: ServerResponse, data: unknown): void {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(data));
  }
}

/**
 * Fire-and-forget push to a running dashboard server.
 * Called from hook handlers to deliver events immediately.
 */
export function pushToDashboard(
  projectRoot: string,
  event: Record<string, unknown>,
  port: number,
  token?: string,
): void {
  try {
    const data = JSON.stringify(event);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/push",
        method: "POST",
        headers,
        timeout: 50,
      },
      () => {
        // Response ignored.
      },
    );
    req.on("error", () => {
      // Swallow all errors — dashboard might not be running.
    });
    req.on("timeout", () => {
      req.destroy();
    });
    req.write(data);
    req.end();
  } catch {
    // Swallow all errors.
  }
}
