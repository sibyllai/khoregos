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
import { AuditLogger } from "../engine/audit.js";
import type { AuditEvent, EventType } from "../models/audit.js";

function withDb<T>(projectRoot: string, fn: (db: Db) => T): T {
  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function resolveSessionId(
  sm: StateManager,
  session: string,
): string | null {
  if (session === "latest") {
    const latest = sm.getLatestSession();
    return latest?.id ?? null;
  }
  return session;
}

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

function printEvent(event: AuditEvent): void {
  const agent = event.agentId ? event.agentId.slice(0, 8) : "system";
  const typeColor: Record<string, (s: string) => string> = {
    file_create: chalk.green,
    file_modify: chalk.yellow,
    file_delete: chalk.red,
    session_start: chalk.blue,
    session_complete: chalk.blue,
  };
  const colorFn = typeColor[event.eventType] ?? chalk.white;
  const time = new Date(event.timestamp).toTimeString().slice(0, 8);

  console.log(
    `${chalk.dim(time)} ${chalk.cyan(agent.padStart(10))} ${colorFn(event.eventType.padEnd(15))} ${event.action}`,
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
    .option("--since <duration>", "Show events since (e.g., '1h', '30m')")
    .option("-n, --limit <number>", "Maximum events to show", "50")
    .action(
      (opts: {
        session: string;
        agent?: string;
        type?: string;
        since?: string;
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
          });
          return { events, sessionId };
        });

        if (!result || !result.events.length) {
          console.log(chalk.dim("No events found."));
          return;
        }

        console.log(`${chalk.bold("Session:")} ${result.sessionId.slice(0, 8)}...`);
        console.log();

        const table = new Table({
          head: ["Time", "Seq", "Agent", "Type", "Action"],
        });

        for (const event of result.events) {
          table.push([
            new Date(event.timestamp).toTimeString().slice(0, 8),
            String(event.sequence),
            event.agentId ? event.agentId.slice(0, 8) + "..." : "system",
            event.eventType,
            event.action.length > 50
              ? event.action.slice(0, 50) + "..."
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
    .option("-o, --output <file>", "Output file (stdout if not specified)")
    .action(
      (opts: { session: string; format: string; output?: string }) => {
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
          return al.getEvents({ limit: 10000 });
        });

        let output: string;

        if (opts.format === "json") {
          output = JSON.stringify(events, null, 2);
        } else if (opts.format === "csv") {
          const header =
            "timestamp,sequence,session_id,agent_id,event_type,action,files_affected";
          const rows = events.map((e) => {
            const files = e.filesAffected
              ? JSON.parse(e.filesAffected).join(";")
              : "";
            return [
              e.timestamp,
              e.sequence,
              e.sessionId,
              e.agentId ?? "",
              e.eventType,
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
}
