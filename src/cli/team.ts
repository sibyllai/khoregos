/**
 * Team management CLI commands.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  DaemonState,
  injectClaudeMdGovernance,
  registerHooks,
  registerMcpServer,
  removeClaudeMdGovernance,
  unregisterHooks,
} from "../daemon/manager.js";
import { loadConfig } from "../models/config.js";
import { type Session, type SessionState } from "../models/session.js";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";

function withDb<T>(projectRoot: string, fn: (db: Db) => T): T {
  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function registerTeamCommands(program: Command): void {
  const team = program
    .command("team")
    .description("Manage agent team sessions");

  team
    .command("start")
    .description("Start an agent team session with governance")
    .argument("<objective>", "What the team will work on")
    .option("-r, --run", "Launch Claude Code with the objective as prompt")
    .action((objective: string, opts: { run?: boolean }) => {
      const projectRoot = process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");
      const khoregoDir = path.join(projectRoot, ".khoregos");

      if (!existsSync(configFile)) {
        console.error(chalk.red("Not initialized.") + " Run " + chalk.bold("k6s init") + " first.");
        process.exit(1);
      }

      const daemon = new DaemonState(khoregoDir);
      if (daemon.isRunning()) {
        const state = daemon.readState();
        const sid = ((state.session_id as string) ?? "unknown").slice(0, 8);
        console.log(chalk.yellow(`Session ${sid}... is already active.`));
        console.log();
        console.log("Continue working with: " + chalk.cyan.bold("claude"));
        console.log("Or stop first with:    " + chalk.bold("k6s team stop"));
        process.exit(1);
      }

      const config = loadConfig(configFile);

      const session = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const s = sm.createSession({
          objective,
          configSnapshot: JSON.stringify(config),
        });
        sm.markSessionActive(s.id);
        return s;
      });

      console.log(chalk.green("✓") + ` Session ${chalk.bold(session.id.slice(0, 8) + "...")} created`);

      injectClaudeMdGovernance(projectRoot, session.id);
      console.log(chalk.green("✓") + " CLAUDE.md updated with governance rules");

      registerMcpServer(projectRoot);
      registerHooks(projectRoot);
      console.log(chalk.green("✓") + " MCP server and hooks registered");

      daemon.writeState({ session_id: session.id });

      const objectiveOneline = objective.replace(/\s+/g, " ").trim();
      console.log();
      console.log(`${chalk.bold("Objective:")} ${objectiveOneline}`);
      console.log();

      if (opts.run) {
        console.log(chalk.bold("Launching Claude Code..."));
        console.log();
        try {
          execFileSync("claude", [objective], { stdio: "inherit" });
        } catch {
          console.error(chalk.red("Claude Code not found."));
          console.error("Make sure 'claude' is in your PATH.");
          process.exit(1);
        }
      } else {
        const escaped = objectiveOneline.replace(/'/g, "'\\''");
        console.log(chalk.green("Session ready!") + " Now run:");
        console.log();
        console.log(`  ${chalk.cyan.bold(`claude '${escaped}'`)}`);
        console.log();
        console.log("When done, run " + chalk.bold("k6s team stop") + " to end the session.");
      }
    });

  team
    .command("stop")
    .description("Stop the current agent team session")
    .action(() => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      const daemon = new DaemonState(khoregoDir);
      if (!daemon.isRunning()) {
        console.log(chalk.yellow("No active session."));
        process.exit(1);
      }

      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";

      withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        sm.markSessionCompleted(sessionId);
      });

      removeClaudeMdGovernance(projectRoot);
      unregisterHooks(projectRoot);
      daemon.removeState();

      console.log(chalk.green("✓") + ` Session ${sessionId.slice(0, 8)}... stopped`);
      console.log(chalk.green("✓") + " Governance removed (CLAUDE.md, hooks)");
    });

  team
    .command("resume")
    .description("Resume a previous session")
    .argument("[session-id]", "Session ID to resume (defaults to latest)")
    .action((sessionId?: string) => {
      const projectRoot = process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");
      const khoregoDir = path.join(projectRoot, ".khoregos");

      if (!existsSync(configFile)) {
        console.error(chalk.red("Not initialized."));
        process.exit(1);
      }

      const daemon = new DaemonState(khoregoDir);
      if (daemon.isRunning()) {
        const st = daemon.readState();
        const sid = ((st.session_id as string) ?? "unknown").slice(0, 8);
        console.log(chalk.yellow(`Session ${sid}... is already active.`));
        console.log();
        console.log("Continue working with: " + chalk.cyan.bold("claude"));
        console.log("Or stop first with:    " + chalk.bold("k6s team stop"));
        process.exit(1);
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);

        let prev: Session | null = null;
        if (sessionId) {
          prev = sm.getSession(sessionId);
        } else {
          const sessions = sm.listSessions({ limit: 1 });
          prev = sessions[0] ?? null;
        }

        if (!prev) return null;

        const context = sm.generateResumeContext(prev.id);
        const config = loadConfig(configFile);
        const newSession = sm.createSession({
          objective: prev.objective,
          configSnapshot: JSON.stringify(config),
          parentSessionId: prev.id,
        });

        sm.saveContext({
          sessionId: newSession.id,
          key: "resume_context",
          value: context,
        });

        sm.markSessionActive(newSession.id);
        return { prev, newSession };
      });

      if (!result) {
        console.log(chalk.yellow("No session found to resume."));
        process.exit(1);
      }

      console.log(chalk.green("✓") + ` Resuming from session ${chalk.bold(result.prev.id.slice(0, 8) + "...")}`);
      console.log(`${chalk.bold("Objective:")} ${result.prev.objective}`);

      injectClaudeMdGovernance(projectRoot, result.newSession.id);
      registerMcpServer(projectRoot);
      registerHooks(projectRoot);
      daemon.writeState({ session_id: result.newSession.id });

      console.log(chalk.green("✓") + ` New session ${chalk.bold(result.newSession.id.slice(0, 8) + "...")} created`);
      console.log(chalk.green("✓") + " Previous context injected into CLAUDE.md");
      console.log();
      console.log(chalk.green("Session ready!") + " Now run:");
      console.log();
      console.log("  " + chalk.cyan.bold("claude"));
      console.log();
      console.log("When done, run " + chalk.bold("k6s team stop") + " to end the session.");
    });

  team
    .command("status")
    .description("Show current team session status")
    .action(() => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      const daemon = new DaemonState(khoregoDir);
      if (!daemon.isRunning()) {
        console.log(chalk.dim("No active session"));
        return;
      }

      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";

      withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const session = sm.getSession(sessionId);
        const agents = session ? sm.listAgents(sessionId) : [];

        if (session) {
          console.log(`${chalk.bold("Session:")} ${session.id.slice(0, 8)}...`);
          console.log(`${chalk.bold("Objective:")} ${session.objective}`);
          console.log(`${chalk.bold("State:")} ${session.state}`);
          console.log(`${chalk.bold("Started:")} ${new Date(session.startedAt).toISOString().slice(0, 16).replace("T", " ")}`);

          if (agents.length) {
            console.log();
            console.log(chalk.bold("Agents:"));
            for (const agent of agents) {
              const spec = agent.specialization ? ` (${agent.specialization})` : "";
              console.log(`  - ${agent.name}${spec} (${agent.role}): ${agent.state}`);
            }
          }
        }
      });
    });

  team
    .command("history")
    .description("List past sessions")
    .option("-n, --limit <number>", "Number of sessions to show", "10")
    .action((opts: { limit: string }) => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");
      const dbPath = path.join(khoregoDir, "k6s.db");

      if (!existsSync(dbPath)) {
        console.log(chalk.yellow("No sessions found."));
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
        head: ["ID", "Objective", "State", "Started", "Cost"],
      });

      const stateColor: Record<string, (s: string) => string> = {
        completed: chalk.green,
        active: chalk.yellow,
        created: chalk.yellow,
        paused: chalk.blue,
        failed: chalk.red,
      };

      for (const s of sessions) {
        const colorFn = stateColor[s.state] ?? chalk.dim;
        table.push([
          s.id.slice(0, 8) + "...",
          s.objective.length > 40 ? s.objective.slice(0, 40) + "..." : s.objective,
          colorFn(s.state),
          new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " "),
          s.totalCostUsd ? `$${s.totalCostUsd.toFixed(2)}` : "-",
        ]);
      }

      console.log(table.toString());
    });
}
