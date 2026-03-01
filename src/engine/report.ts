import path from "node:path";
import type { Db } from "../store/db.js";
import { StateManager } from "./state.js";
import { AuditLogger } from "./audit.js";
import { BoundaryEnforcer } from "./boundaries.js";
import { loadSigningKey, verifyChain } from "./signing.js";
import type { AuditEvent } from "../models/audit.js";
import type { BoundaryConfig } from "../models/config.js";
import type { BoundaryViolation } from "../models/context.js";

const EVENT_TYPE_DISPLAY: Record<string, string> = {
  gate_triggered: "sensitive_needs_review",
};

function displayEventType(eventType: string): string {
  return EVENT_TYPE_DISPLAY[eventType] ?? eventType;
}

function fallback(value: string | null): string {
  return value ?? "—";
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "ongoing";

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const deltaMs = Math.max(0, endMs - startMs);
  const totalSeconds = Math.floor(deltaMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    return [];
  }
  return [];
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const out: string[] = [];
  out.push(`| ${headers.join(" | ")} |`);
  out.push(`|${headers.map(() => "------").join("|")}|`);
  out.push(...rows.map((row) => `| ${row.join(" | ")} |`));
  return out;
}

function timelineAgentLabel(
  event: AuditEvent,
  agentNameById: Map<string, string>,
): string {
  if (!event.agentId) return "system";
  return agentNameById.get(event.agentId) ?? `${event.agentId.slice(0, 8)}...`;
}

function violationAgentLabel(
  violation: BoundaryViolation,
  agentNameById: Map<string, string>,
): string {
  if (!violation.agentId) return "system";
  return agentNameById.get(violation.agentId) ?? `${violation.agentId.slice(0, 8)}...`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

export function generateAuditReport(
  db: Db,
  sessionId: string,
  projectRoot: string,
): string {
  const sm = new StateManager(db, projectRoot);
  const session = sm.getSession(sessionId);
  if (!session) {
    return [
      "# Khoregos audit report",
      "",
      "No session found.",
    ].join("\n");
  }

  const agents = sm.listAgents(sessionId);
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const logger = new AuditLogger(db, sessionId);
  const eventsDesc = logger.getEvents({ limit: 100000 });
  const events = [...eventsDesc].reverse();

  const report: string[] = [];
  report.push("# Khoregos audit report");
  report.push("");
  report.push("## Session summary");
  report.push("");
  report.push(
    ...renderTable(
      ["Field", "Value"],
      [
        ["Session ID", session.id],
        ["Objective", session.objective],
        ["Operator", fallback(session.operator)],
        ["Hostname", fallback(session.hostname)],
        ["State", session.state],
        ["Started", session.startedAt],
        ["Ended", fallback(session.endedAt)],
        ["Duration", formatDuration(session.startedAt, session.endedAt)],
        ["Git branch", fallback(session.gitBranch)],
        ["Git SHA", fallback(session.gitSha)],
        ["Trace ID", fallback(session.traceId)],
        ["k6s version", fallback(session.k6sVersion)],
      ],
    ),
  );
  report.push("");

  report.push("## Agents");
  report.push("");
  if (agents.length === 0) {
    report.push("No agents registered.");
  } else {
    const agentRows = agents.map((agent) => [
      agent.name,
      agent.role,
      agent.state,
      agent.spawnedAt,
    ]);
    report.push(...renderTable(["Name", "Role", "State", "Spawned"], agentRows));
  }
  report.push("");

  report.push("## Audit chain integrity");
  report.push("");
  const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
  if (!signingKey) {
    report.push("No signing key found. Run `k6s init` to generate one.");
  } else {
    const verification = verifyChain(signingKey, sessionId, events);
    report.push(`Status: ${verification.valid ? "valid" : "invalid"}.`);
    report.push(`Events checked: ${verification.eventsChecked}.`);
    if (verification.errors.length === 0) {
      report.push("Errors: none.");
    } else {
      report.push("Errors:");
      for (const err of verification.errors) {
        report.push(`- Seq ${err.sequence} (${err.type}): ${err.message}.`);
      }
    }
  }
  report.push("");

  report.push("## Event timeline");
  report.push("");
  if (events.length === 0) {
    report.push("No events recorded.");
  } else {
    const timelineRows = events.map((event) => [
      event.timestamp,
      String(event.sequence),
      timelineAgentLabel(event, agentNameById),
      event.severity,
      displayEventType(event.eventType),
      event.action,
    ]);
    report.push(
      ...renderTable(
        ["Time", "Seq", "Agent", "Severity", "Type", "Action"],
        timelineRows,
      ),
    );
  }
  report.push("");

  report.push("## Files modified");
  report.push("");
  const files = new Set<string>();
  for (const event of events) {
    for (const filePath of parseStringArray(event.filesAffected)) {
      files.add(filePath);
    }
  }
  if (files.size === 0) {
    report.push("No files recorded.");
  } else {
    for (const filePath of [...files].sort((a, b) => a.localeCompare(b))) {
      report.push(`- ${filePath}`);
    }
  }
  report.push("");

  report.push("## Sensitive file annotations");
  report.push("");
  const gateEvents = events.filter((event) => event.eventType === "gate_triggered");
  if (gateEvents.length === 0) {
    report.push("No sensitive file annotations.");
  } else {
    for (const event of gateEvents) {
      const details = parseJsonObject(event.details);
      const ruleName = stringifyValue(details?.rule_id);
      const fileName = stringifyValue(details?.file);
      report.push(
        `- ${event.timestamp} sensitive_needs_review rule=${ruleName} file=${fileName}`,
      );
    }
  }
  report.push("");

  report.push("## Boundary violations");
  report.push("");
  let violations: BoundaryViolation[] | null = null;
  const snapshot = parseJsonObject(session.configSnapshot);
  const maybeBoundaries = snapshot?.boundaries;
  if (Array.isArray(maybeBoundaries)) {
    const boundaryEnforcer = new BoundaryEnforcer(
      db,
      sessionId,
      projectRoot,
      maybeBoundaries as BoundaryConfig[],
    );
    violations = boundaryEnforcer.getViolations();
  }

  if (!violations) {
    report.push("No boundary configuration snapshot available for this session.");
  } else if (violations.length === 0) {
    report.push("No boundary violations.");
  } else {
    const orderedViolations = [...violations].reverse();
    const rows = orderedViolations.map((violation) => [
      violation.timestamp,
      violationAgentLabel(violation, agentNameById),
      violation.filePath,
      violation.violationType,
      violation.enforcementAction,
    ]);
    report.push(...renderTable(["Time", "Agent", "File", "Type", "Action"], rows));
  }
  report.push("");

  report.push("## Event summary by type");
  report.push("");
  if (events.length === 0) {
    report.push("No events recorded.");
  } else {
    const counts = new Map<string, number>();
    for (const event of events) {
      const type = displayEventType(event.eventType);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const typeRows = [...counts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .map(([type, count]) => [type, String(count)]);
    report.push(...renderTable(["Type", "Count"], typeRows));
  }
  report.push("");

  report.push("## Event summary by severity");
  report.push("");
  const severityCounts = { info: 0, warning: 0, critical: 0 };
  for (const event of events) {
    severityCounts[event.severity] += 1;
  }
  report.push(
    ...renderTable(
      ["Severity", "Count"],
      [
        ["info", String(severityCounts.info)],
        ["warning", String(severityCounts.warning)],
        ["critical", String(severityCounts.critical)],
      ],
    ),
  );
  report.push("");

  return report.join("\n");
}
