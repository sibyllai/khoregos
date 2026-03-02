import path from "node:path";
import type { Db } from "../store/db.js";
import { StateManager } from "./state.js";
import { AuditLogger } from "./audit.js";
import { BoundaryEnforcer } from "./boundaries.js";
import { displayEventType } from "./event-types.js";
import { loadSigningKey, verifyChain } from "./signing.js";
import type { AuditEvent } from "../models/audit.js";
import type { BoundaryConfig, ClassificationLevel } from "../models/config.js";
import type { BoundaryViolation } from "../models/context.js";

export type ReportStandard = "generic" | "soc2" | "iso27001";

const SOC2_MAPPINGS: Record<string, { control: string; description: string }> = {
  session_start: {
    control: "CC6.1",
    description: "Logical and physical access controls — session initiation with operator attribution.",
  },
  session_complete: {
    control: "CC6.1",
    description: "Logical and physical access controls — session completion and cleanup.",
  },
  tool_use: {
    control: "CC8.1",
    description: "Change management — tool invocations are recorded with agent attribution.",
  },
  boundary_violation: {
    control: "CC6.3",
    description: "Access controls — unauthorized access attempts are detected and logged.",
  },
  gate_triggered: {
    control: "CC8.1",
    description: "Change management — sensitive file modifications are flagged for review.",
  },
  dependency_added: {
    control: "CC7.1",
    description: "System operations — supply chain changes are tracked.",
  },
  dependency_removed: {
    control: "CC7.1",
    description: "System operations — supply chain changes are tracked.",
  },
  dependency_updated: {
    control: "CC7.1",
    description: "System operations — supply chain changes are tracked.",
  },
  agent_spawn: {
    control: "CC6.2",
    description: "Access controls — new agent identity is registered.",
  },
  agent_complete: {
    control: "CC6.2",
    description: "Access controls — agent lifecycle completion is recorded.",
  },
  lock_acquired: {
    control: "CC6.1",
    description: "Logical access — resource locking coordinates concurrent agents.",
  },
};

const ISO27001_MAPPINGS: Record<string, { control: string; description: string }> = {
  session_start: {
    control: "A.12.4.1",
    description: "Event logging — session initiation with operator context.",
  },
  session_complete: {
    control: "A.12.4.1",
    description: "Event logging — session termination is recorded.",
  },
  tool_use: {
    control: "A.12.4.1",
    description: "Event logging — tool operations are recorded.",
  },
  boundary_violation: {
    control: "A.9.4.1",
    description: "Information access restriction — boundary violations are detected.",
  },
  gate_triggered: {
    control: "A.14.2.2",
    description: "System change control procedures — sensitive changes are flagged.",
  },
  dependency_added: {
    control: "A.14.2.7",
    description: "Outsourced development — supply chain changes are tracked.",
  },
  dependency_removed: {
    control: "A.14.2.7",
    description: "Outsourced development — supply chain changes are tracked.",
  },
  dependency_updated: {
    control: "A.14.2.7",
    description: "Outsourced development — supply chain changes are tracked.",
  },
  agent_spawn: {
    control: "A.9.2.1",
    description: "User registration — agent identity is established.",
  },
  lock_acquired: {
    control: "A.9.4.1",
    description: "Information access restriction — resource locks are recorded.",
  },
};

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

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const out: string[] = [];
  out.push(`| ${headers.map(escapeCell).join(" | ")} |`);
  out.push(`|${headers.map(() => "------").join("|")}|`);
  out.push(...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`));
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

function isClassificationLevel(value: unknown): value is ClassificationLevel {
  return value === "public"
    || value === "internal"
    || value === "confidential"
    || value === "restricted";
}

function reportTitle(standard: ReportStandard): string {
  if (standard === "soc2") return "# Khoregos audit report — SOC 2";
  if (standard === "iso27001") return "# Khoregos audit report — ISO 27001";
  return "# Khoregos audit report";
}

function appendComplianceMappingSection(
  report: string[],
  events: AuditEvent[],
  standard: ReportStandard,
): void {
  if (standard === "generic") return;

  const mapping = standard === "soc2" ? SOC2_MAPPINGS : ISO27001_MAPPINGS;
  const sectionTitle = standard === "soc2"
    ? "## SOC 2 compliance mapping"
    : "## ISO 27001 compliance mapping";
  const intro = standard === "soc2"
    ? "This section maps observed audit events to SOC 2 Trust Services Criteria."
    : "This section maps observed audit events to ISO 27001 Annex A controls.";
  const controlHeader = standard === "soc2" ? "Criteria" : "Control";

  const summary = new Map<string, { description: string; count: number; evidence: Set<string> }>();
  const unmapped = new Set<string>();

  for (const event of events) {
    const mapped = mapping[event.eventType];
    if (!mapped) {
      unmapped.add(displayEventType(event.eventType));
      continue;
    }

    const current = summary.get(mapped.control) ?? {
      description: mapped.description,
      count: 0,
      evidence: new Set<string>(),
    };
    current.count += 1;
    current.evidence.add(displayEventType(event.eventType));
    summary.set(mapped.control, current);
  }

  report.push(sectionTitle);
  report.push("");
  report.push(intro);
  report.push("");

  if (summary.size === 0) {
    report.push("No mapped events observed for this standard.");
  } else {
    const rows = [...summary.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([control, details]) => [
        control,
        details.description,
        String(details.count),
        [...details.evidence].sort((a, b) => a.localeCompare(b)).join(", "),
      ]);
    report.push(
      ...renderTable(
        [controlHeader, "Description", "Events", "Evidence"],
        rows,
      ),
    );
  }
  report.push("");
  if (unmapped.size === 0) {
    report.push("Unmapped event types observed: none.");
  } else {
    report.push(`Unmapped event types observed: ${[...unmapped].sort((a, b) => a.localeCompare(b)).join(", ")}.`);
  }
  report.push("");
}

function appendDataClassificationSummary(
  report: string[],
  events: AuditEvent[],
  classificationsConfigured: boolean,
): void {
  if (!classificationsConfigured) return;

  const counts = new Map<ClassificationLevel, number>([
    ["public", 0],
    ["internal", 0],
    ["confidential", 0],
    ["restricted", 0],
  ]);
  const filesByLevel = new Map<ClassificationLevel, Set<string>>([
    ["public", new Set<string>()],
    ["internal", new Set<string>()],
    ["confidential", new Set<string>()],
    ["restricted", new Set<string>()],
  ]);

  let anyClassifiedFileEvents = false;
  for (const event of events) {
    const affected = parseStringArray(event.filesAffected);
    if (affected.length === 0) continue;
    anyClassifiedFileEvents = true;
    const details = parseJsonObject(event.details);
    const classification = isClassificationLevel(details?.classification)
      ? details.classification
      : "public";
    counts.set(classification, (counts.get(classification) ?? 0) + 1);
    const files = filesByLevel.get(classification);
    if (files) {
      for (const filePath of affected) {
        files.add(filePath);
      }
    }
  }

  report.push("## Data classification summary");
  report.push("");
  if (!anyClassifiedFileEvents) {
    report.push("No file-affecting events were recorded.");
    report.push("");
    return;
  }

  const levelOrder: ClassificationLevel[] = [
    "restricted",
    "confidential",
    "internal",
    "public",
  ];
  const rows = levelOrder.map((level) => [
    level,
    String(counts.get(level) ?? 0),
    String(filesByLevel.get(level)?.size ?? 0),
  ]);
  report.push(...renderTable(["Classification", "Events", "Unique files"], rows));
  report.push("");

  for (const level of levelOrder) {
    const files = [...(filesByLevel.get(level) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
    report.push(`### ${level}`);
    if (files.length === 0) {
      report.push("No files touched.");
    } else {
      for (const filePath of files) {
        report.push(`- ${filePath}`);
      }
    }
    report.push("");
  }
}

export function generateAuditReport(
  db: Db,
  sessionId: string,
  projectRoot: string,
  standard: ReportStandard = "generic",
): string {
  const sm = new StateManager(db, projectRoot);
  const session = sm.getSession(sessionId);
  if (!session) {
    return [
      reportTitle(standard),
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
  report.push(reportTitle(standard));
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

  appendComplianceMappingSection(report, events, standard);

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

  const snapshot = parseJsonObject(session.configSnapshot);
  const configuredClassifications = Array.isArray(snapshot?.classifications)
    && snapshot.classifications.length > 0;
  appendDataClassificationSummary(report, events, configuredClassifications);

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
