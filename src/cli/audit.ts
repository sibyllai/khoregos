/**
 * Audit trail CLI commands.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { AuditLogger, pruneAuditEvents } from "../engine/audit.js";
import { loadSigningKey, verifyChain } from "../engine/signing.js";
import { generateAuditReport } from "../engine/report.js";
import { loadConfigOrDefault } from "../models/config.js";
import type {
  AuditEvent,
  AuditSeverity,
  EventType,
} from "../models/audit.js";
import { withDb, resolveSessionId } from "./shared.js";

function parseDuration(duration: string): string {
  const value = parseInt(duration.slice(0, -1), 10);
  const unit = duration.slice(-1);
  const now = Date.now();

  let ms: number;
  switch (unit) {
    case "h":
      ms = value * 3600 * 1000;
      break;
    case "m":
      ms = value * 60 * 1000;
      break;
    case "d":
      ms = value * 86400 * 1000;
      break;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
  return new Date(now - ms).toISOString();
}

/** Map internal event types to user-facing display names. */
const EVENT_TYPE_DISPLAY: Record<string, string> = {
  gate_triggered: "sensitive_needs_review",
};

function displayEventType(eventType: string): string {
  return EVENT_TYPE_DISPLAY[eventType] ?? eventType;
}

/** Format a millisecond delta as a human-readable short string. */
function formatDeltaMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function printEvent(event: AuditEvent): void {
  const agent = event.agentId ? event.agentId.slice(0, 8) : "system";
  const typeColor: Record<string, (s: string) => string> = {
    file_create: chalk.green,
    file_modify: chalk.yellow,
    file_delete: chalk.red,
    session_start: chalk.blue,
    session_complete: chalk.blue,
    sensitive_needs_review: chalk.magenta,
  };
  const displayType = displayEventType(event.eventType);
  const colorFn = typeColor[displayType] ?? chalk.white;
  const time = new Date(event.timestamp).toTimeString().slice(0, 8);

  console.log(
    `${chalk.dim(time)} ${chalk.cyan(agent.padStart(10))} ${colorFn(displayType.padEnd(15))} ${event.action}`,
  );
}

export function registerAuditCommands(program: Command): void {
  const audit = program.command("audit").description("View audit trail");

  audit
    .command("show")
    .description("Show audit trail events")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-a, --agent <name>", "Filter by agent name")
    .option("-t, --type <type>", "Filter by event type")
    .option(
      "--severity <level>",
      "Filter by severity (info, warning, critical)",
    )
    .option("--since <duration>", "Show events since (e.g., '1h', '30m')")
    .option("--trace-id <id>", "Filter by trace/correlation ID")
    .option("-n, --limit <number>", "Maximum events to show", "50")
    .action(
      (opts: {
        session: string;
        agent?: string;
        type?: string;
        severity?: string;
        since?: string;
        traceId?: string;
        limit: string;
      }) => {
        const projectRoot = process.cwd();
        if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
          console.log(chalk.yellow("No audit data found."));
          return;
        }

        const result = withDb(projectRoot, (db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) return null;

          const al = new AuditLogger(db, sessionId);
          const events = al.getEvents({
            limit: parseInt(opts.limit, 10),
            eventType: opts.type as EventType | undefined,
            since: opts.since ? parseDuration(opts.since) : undefined,
            severity: opts.severity as AuditSeverity | undefined,
            traceId: opts.traceId,
          });

          // Build agent ID -> name map for display.
          const agents = sm.listAgents(sessionId);
          const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

          const session = sm.getSession(sessionId);
          return { events, sessionId, agentNameById, traceId: session?.traceId };
        });

        if (!result || !result.events.length) {
          console.log(chalk.dim("No events found."));
          return;
        }

        console.log(`${chalk.bold("Session:")} ${result.sessionId.slice(0, 8)}...`);
        if (result.traceId) {
          console.log(`${chalk.bold("Trace ID:")} ${result.traceId}`);
        }
        console.log();

        const table = new Table({
          head: ["Time", "Seq", "Delta", "Agent", "Sev", "Type", "Action"],
        });

        // Compute delta (time since previous event) in sequence order.
        // Events arrive DESC; reverse for ascending computation.
        const ascending = [...result.events].reverse();
        const deltaBySeq = new Map<number, string>();
        for (let i = 0; i < ascending.length; i++) {
          if (i === 0) {
            deltaBySeq.set(ascending[i].sequence, "—");
          } else {
            const prev = new Date(ascending[i - 1].timestamp).getTime();
            const curr = new Date(ascending[i].timestamp).getTime();
            const ms = curr - prev;
            deltaBySeq.set(ascending[i].sequence, formatDeltaMs(ms));
          }
        }

        const severityColor: Record<string, (s: string) => string> = {
          critical: chalk.red,
          warning: chalk.yellow,
          info: chalk.dim,
        };
        for (const event of result.events) {
          const sev = event.severity ?? "info";
          const colorFn = severityColor[sev] ?? chalk.dim;
          const agentLabel = event.agentId
            ? result.agentNameById.get(event.agentId) ?? event.agentId.slice(0, 8) + "..."
            : "system";
          table.push([
            new Date(event.timestamp).toTimeString().slice(0, 8),
            String(event.sequence),
            chalk.dim(deltaBySeq.get(event.sequence) ?? "—"),
            agentLabel,
            colorFn(sev.slice(0, 4)),
            displayEventType(event.eventType),
            event.action.length > 45
              ? event.action.slice(0, 45) + "..."
              : event.action,
          ]);
        }

        console.log(table.toString());
      },
    );

  audit
    .command("tail")
    .description("Live stream audit events")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("--no-follow", "Don't follow new events")
    .action((opts: { session: string; follow: boolean }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      console.log(chalk.dim("Streaming audit events (Ctrl+C to stop)..."));
      console.log();

      let lastSequence = 0;

      const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
      db.connect();

      try {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) {
          console.log(chalk.yellow("No session found."));
          return;
        }

        const al = new AuditLogger(db, sessionId);

        // Show recent events first
        const events = al.getEvents({ limit: 10 });
        for (const event of [...events].reverse()) {
          printEvent(event);
          lastSequence = Math.max(lastSequence, event.sequence);
        }

        if (!opts.follow) return;

        // Poll for new events
        const interval = setInterval(() => {
          const newEvents = al.getEvents({ limit: 100 });
          const fresh = newEvents.filter((e) => e.sequence > lastSequence);
          for (const event of [...fresh].reverse()) {
            printEvent(event);
            lastSequence = Math.max(lastSequence, event.sequence);
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(interval);
          console.log(chalk.dim("\nStopped."));
          db.close();
          process.exit(0);
        });
      } catch {
        db.close();
      }
    });

  audit
    .command("export")
    .description("Export audit trail")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-f, --format <format>", "Output format: json, csv", "json")
    .option("--trace-id <id>", "Filter by trace/correlation ID")
    .option("-o, --output <file>", "Output file (stdout if not specified)")
    .action(
      (opts: { session: string; format: string; traceId?: string; output?: string }) => {
        const projectRoot = process.cwd();
        if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
          console.error(chalk.yellow("No audit data found."));
          return;
        }

        const events = withDb(projectRoot, (db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) return [];

          const al = new AuditLogger(db, sessionId);
          return al.getEvents({ limit: 10000, traceId: opts.traceId });
        });

        let output: string;

        if (opts.format === "json") {
          output = JSON.stringify(events, null, 2);
        } else if (opts.format === "csv") {
          const header =
            "timestamp,sequence,session_id,agent_id,severity,event_type,action,files_affected";
          const rows = events.map((e) => {
            const files = e.filesAffected
              ? JSON.parse(e.filesAffected).join(";")
              : "";
            return [
              e.timestamp,
              e.sequence,
              e.sessionId,
              e.agentId ?? "",
              e.severity ?? "info",
              displayEventType(e.eventType),
              `"${e.action.replace(/"/g, '""')}"`,
              files,
            ].join(",");
          });
          output = [header, ...rows].join("\n");
        } else {
          console.error(chalk.red(`Unknown format: ${opts.format}`));
          process.exit(1);
        }

        if (opts.output) {
          writeFileSync(opts.output, output);
          console.log(
            chalk.green("✓") +
              ` Exported ${events.length} events to ${opts.output}`,
          );
        } else {
          console.log(output);
        }
      },
    );

  // -- Prune old audit data.
  audit
    .command("prune")
    .description("Delete audit events older than the retention period")
    .option(
      "--before <date>",
      "Delete events before this ISO date (overrides retention config)",
    )
    .option("--dry-run", "Show what would be deleted without deleting")
    .action((opts: { before?: string; dryRun?: boolean }) => {
      const projectRoot = process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");

      let beforeDate: string;
      if (opts.before) {
        beforeDate = new Date(opts.before).toISOString();
      } else {
        const config = loadConfigOrDefault(configFile, "project");
        const retentionDays = config.session.audit_retention_days;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        beforeDate = cutoff.toISOString();
      }

      const result = withDb(projectRoot, (db) => {
        return pruneAuditEvents(db, beforeDate, opts.dryRun ?? false);
      });

      if (opts.dryRun) {
        console.log(chalk.dim("Dry run — no data deleted."));
        console.log(
          `  Events that would be deleted: ${chalk.bold(String(result.eventsDeleted))}`,
        );
        console.log(
          `  Sessions that would be pruned: ${chalk.bold(String(result.sessionsPruned))}`,
        );
      } else {
        console.log(
          chalk.green("✓") +
            ` Pruned ${result.eventsDeleted} events, ${result.sessionsPruned} sessions`,
        );
      }
    });

  // -- Verify HMAC chain integrity.
  audit
    .command("verify")
    .description("Verify audit trail HMAC chain integrity")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .action((opts: { session: string }) => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      if (!existsSync(path.join(khoregoDir, "k6s.db"))) {
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      const key = loadSigningKey(khoregoDir);
      if (!key) {
        console.log(
          chalk.yellow("No signing key found.") +
            " Run " +
            chalk.bold("k6s init") +
            " to generate one.",
        );
        return;
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;

        // Fetch all events in sequence order (ascending).
        const events = db
          .fetchAll(
            "SELECT * FROM audit_events WHERE session_id = ? ORDER BY sequence ASC",
            [sessionId],
          )
          .map((row) => ({
            id: row.id as string,
            sequence: row.sequence as number,
            sessionId: row.session_id as string,
            agentId: (row.agent_id as string) ?? null,
            timestamp: row.timestamp as string,
            eventType: row.event_type as string,
            action: row.action as string,
            details: (row.details as string) ?? null,
            filesAffected: (row.files_affected as string) ?? null,
            gateId: (row.gate_id as string) ?? null,
            hmac: (row.hmac as string) ?? null,
            severity: ((row.severity as string) ?? "info") as AuditSeverity,
          })) as AuditEvent[];

        return { sessionId, verification: verifyChain(key, sessionId, events) };
      });

      if (!result) {
        console.log(chalk.yellow("No session found."));
        return;
      }

      const { sessionId, verification } = result;
      console.log(`${chalk.bold("Session:")} ${sessionId.slice(0, 8)}...`);
      console.log(
        `${chalk.bold("Events checked:")} ${verification.eventsChecked}`,
      );
      console.log();

      if (verification.valid) {
        console.log(chalk.green("✓ Audit chain integrity verified."));
      } else {
        console.log(
          chalk.red(`✗ ${verification.errors.length} issue(s) found:`),
        );
        console.log();
        for (const err of verification.errors) {
          const prefix =
            err.type === "mismatch"
              ? chalk.red("BROKEN")
              : err.type === "gap"
                ? chalk.yellow("GAP")
                : chalk.yellow("UNSIGNED");
          console.log(`  ${prefix} seq ${err.sequence}: ${err.message}`);
        }
      }
    });

  audit
    .command("report")
    .description("Generate a structured audit report for a session")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-o, --output <file>", "Write report to file (stdout if omitted)")
    .action((opts: { session: string; output?: string }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      const report = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;
        return generateAuditReport(db, sessionId, projectRoot);
      });

      if (!report) {
        console.log(chalk.yellow("No session found."));
        return;
      }

      if (opts.output) {
        writeFileSync(opts.output, report);
        console.log(chalk.green("✓") + ` Wrote audit report to ${opts.output}`);
      } else {
        console.log(report);
      }
    });
}
