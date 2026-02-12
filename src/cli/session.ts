/**
 * Session management CLI commands.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { AuditLogger } from "../engine/audit.js";
import { type Session, sessionDurationSeconds } from "../models/session.js";

function withDb<T>(projectRoot: string, fn: (db: Db) => T): T {
  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function findSession(sm: StateManager, sessionId: string): Session | null {
  if (sessionId.toLowerCase() === "latest") {
    const sessions = sm.listSessions({ limit: 1 });
    return sessions[0] ?? null;
  }
  const sessions = sm.listSessions({ limit: 100 });
  for (const s of sessions) {
    if (s.id === sessionId || s.id.startsWith(sessionId)) return s;
  }
  return null;
}

export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Manage sessions");

  session
    .command("list")
    .description("List all sessions")
    .option("-n, --limit <number>", "Maximum sessions to show", "20")
    .action((opts: { limit: string }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.dim("No sessions found."));
        return;
      }

      const sessions = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        return sm.listSessions({ limit: parseInt(opts.limit, 10) });
      });

      if (!sessions.length) {
        console.log(chalk.dim("No sessions found."));
        return;
      }

      const table = new Table({
        head: ["ID", "Objective", "State", "Started", "Duration", "Cost", "Tokens"],
      });

      const stateColor: Record<string, (s: string) => string> = {
        completed: chalk.green,
        active: chalk.yellow,
        created: chalk.yellow,
        paused: chalk.blue,
        failed: chalk.red,
      };

      for (const s of sessions) {
        const dur = sessionDurationSeconds(s);
        let duration = "-";
        if (dur !== null) {
          const hours = Math.floor(dur / 3600);
          const minutes = Math.floor((dur % 3600) / 60);
          duration = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        const colorFn = stateColor[s.state] ?? chalk.dim;
        const tokens =
          s.totalInputTokens || s.totalOutputTokens
            ? (s.totalInputTokens + s.totalOutputTokens).toLocaleString()
            : "-";

        table.push([
          s.id.slice(0, 8) + "...",
          s.objective.length > 35 ? s.objective.slice(0, 35) + "..." : s.objective,
          colorFn(s.state),
          new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " "),
          duration,
          s.totalCostUsd ? `$${s.totalCostUsd.toFixed(2)}` : "-",
          tokens,
        ]);
      }

      console.log(table.toString());
    });

  session
    .command("latest")
    .description("Show the most recent session")
    .action(() => {
      showSessionDetails("latest");
    });

  session
    .command("show")
    .description("Show detailed session information")
    .argument("<session-id>", "Session ID (or prefix). Use 'latest' for most recent.")
    .action((sessionId: string) => {
      showSessionDetails(sessionId);
    });

  session
    .command("context")
    .description("View saved context for a session")
    .argument("<session-id>", "Session ID (or prefix). Use 'latest' for most recent.")
    .option("-k, --key <key>", "Specific context key to show")
    .option("-f, --format <format>", "Output format: text, json", "text")
    .action((sessionId: string, opts: { key?: string; format: string }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No sessions found."));
        return;
      }

      const entries = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const s = findSession(sm, sessionId);
        if (!s) return null;

        if (opts.key) {
          const entry = sm.loadContext(s.id, opts.key);
          return entry ? [entry] : [];
        }
        return sm.loadAllContext(s.id);
      });

      if (entries === null) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }

      if (!entries.length) {
        console.log(opts.key
          ? chalk.yellow(`Context key not found: ${opts.key}`)
          : chalk.dim("No context saved for this session."));
        return;
      }

      if (opts.format === "json") {
        const data = entries.map((e) => ({
          key: e.key,
          value: e.value,
          updated_at: e.updatedAt,
        }));
        console.log(JSON.stringify(data, null, 2));
      } else {
        for (const entry of entries) {
          console.log(chalk.cyan.bold(entry.key));
          console.log(chalk.dim(`Updated: ${new Date(entry.updatedAt).toISOString().slice(0, 19).replace("T", " ")}`));
          console.log();
          console.log(entry.value);
          console.log();
        }
      }
    });

  session
    .command("delete")
    .description("Delete a session and all its data")
    .argument("<session-id>", "Session ID to delete")
    .option("-f, --force", "Skip confirmation")
    .action((sessionId: string, opts: { force?: boolean }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No sessions found."));
        return;
      }

      const session = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        return findSession(sm, sessionId);
      });

      if (!session) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }

      if (!opts.force) {
        // In a real CLI we'd prompt for confirmation.
        // For now, require --force.
        console.log(chalk.yellow(`Delete session ${session.id.slice(0, 8)}...?`));
        console.log(`Objective: ${session.objective}`);
        console.log("Use --force to confirm deletion.");
        return;
      }

      withDb(projectRoot, (db) => {
        const tables = [
          "audit_events",
          "agents",
          "context_store",
          "file_locks",
          "boundary_violations",
          "gates",
          "cost_records",
        ];
        for (const table of tables) {
          db.delete(table, "session_id = ?", [session.id]);
        }
        db.delete("sessions", "id = ?", [session.id]);
      });

      console.log(chalk.green("✓") + ` Session ${session.id.slice(0, 8)}... deleted`);
    });
}

function showSessionDetails(sessionId: string): void {
  const projectRoot = process.cwd();
  if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
    console.log(chalk.yellow("No sessions found."));
    return;
  }

  const data = withDb(projectRoot, (db) => {
    const sm = new StateManager(db, projectRoot);
    const s = findSession(sm, sessionId);
    if (!s) return null;

    const agents = sm.listAgents(s.id);
    const al = new AuditLogger(db, s.id);
    const eventCount = al.getEventCount();
    const context = sm.loadAllContext(s.id);

    return { session: s, agents, eventCount, context };
  });

  if (!data) {
    console.error(chalk.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }

  const { session, agents, eventCount, context } = data;

  console.log(chalk.bold("Session Details"));
  console.log(`  ${chalk.bold("ID:")} ${session.id}`);
  console.log(`  ${chalk.bold("Objective:")} ${session.objective}`);
  console.log(`  ${chalk.bold("State:")} ${session.state}`);
  console.log(`  ${chalk.bold("Started:")} ${new Date(session.startedAt).toISOString().slice(0, 19).replace("T", " ")}`);
  console.log(`  ${chalk.bold("Ended:")} ${session.endedAt ? new Date(session.endedAt).toISOString().slice(0, 19).replace("T", " ") : "-"}`);
  console.log(`  ${chalk.bold("Parent:")} ${session.parentSessionId ? session.parentSessionId.slice(0, 8) + "..." : "-"}`);
  console.log(`  ${chalk.bold("Cost:")} $${session.totalCostUsd.toFixed(4)}`);
  console.log(`  ${chalk.bold("Tokens:")} ${session.totalInputTokens.toLocaleString()} in / ${session.totalOutputTokens.toLocaleString()} out`);
  console.log(`  ${chalk.bold("Audit Events:")} ${eventCount.toLocaleString()}`);

  if (agents.length) {
    console.log();
    console.log(chalk.bold("Agents:"));
    for (const agent of agents) {
      const spec = agent.specialization ? ` (${agent.specialization})` : "";
      console.log(`  ${chalk.cyan(agent.name)}${spec} - ${agent.role}, ${agent.state}`);
    }
  }

  if (context.length) {
    console.log();
    console.log(chalk.bold("Saved Context:"));
    for (const entry of context.slice(0, 10)) {
      const val = entry.value.length > 60 ? entry.value.slice(0, 60) + "..." : entry.value;
      console.log(`  ${chalk.dim(entry.key + ":")} ${val}`);
    }
  }

  if (session.contextSummary) {
    console.log();
    console.log(chalk.bold("Session Summary:"));
    console.log(session.contextSummary);
  }
}
