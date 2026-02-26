/**
 * Team management CLI commands.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { execFileSync, spawn } from "node:child_process";
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
import { AuditLogger, pruneAuditEvents } from "../engine/audit.js";
import { loadSigningKey } from "../engine/signing.js";
import {
  getTracer,
  redactEndpointForLogs,
  recordSessionStart,
} from "../engine/telemetry.js";
import { loadConfig, sanitizeConfigForStorage } from "../models/config.js";
import { type Session, type SessionState } from "../models/session.js";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { VERSION } from "../version.js";

function getGitContext(projectRoot: string): {
  branch: string | null;
  sha: string | null;
  dirty: boolean;
} {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    return {
      branch: branch || null,
      sha: sha || null,
      dirty: status.length > 0,
    };
  } catch {
    return { branch: null, sha: null, dirty: false };
  }
}

function getClaudeCodeVersion(): string | null {
  try {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function withDb<T>(projectRoot: string, fn: (db: Db) => T): T {
  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function telemetryPidFile(projectRoot: string): string {
  return path.join(projectRoot, ".khoregos", "telemetry.pid");
}

export function readTelemetryPid(projectRoot: string): number | null {
  const pidPath = telemetryPidFile(projectRoot);
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearTelemetryPid(projectRoot: string): void {
  const pidPath = telemetryPidFile(projectRoot);
  try {
    unlinkSync(pidPath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function stopTelemetryDaemon(projectRoot: string): void {
  const pid = readTelemetryPid(projectRoot);
  if (!pid) {
    clearTelemetryPid(projectRoot);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.error(`Warning: Failed to stop telemetry daemon (pid ${pid}): ${(e as Error).message}.`);
    }
  } finally {
    clearTelemetryPid(projectRoot);
  }
}

export function startTelemetryDaemon(projectRoot: string): void {
  stopTelemetryDaemon(projectRoot);
  const child = spawn(
    "k6s",
    ["telemetry", "serve", "--project-root", projectRoot],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  writeFileSync(telemetryPidFile(projectRoot), `${child.pid}\n`, { mode: 0o600 });
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
    .action(async (objective: string, opts: { run?: boolean }) => {
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
      if (config.observability?.opentelemetry?.enabled) {
        const endpoint = config.observability.opentelemetry.endpoint ?? "http://localhost:4318";
        const safeEndpoint = redactEndpointForLogs(endpoint);
        console.log(chalk.dim(`Sending traces to ${safeEndpoint}. Ensure your OTLP collector is running.`));
      }
      if (config.observability?.prometheus?.enabled) {
        const port = config.observability.prometheus.port ?? 9090;
        console.log(chalk.dim(`Prometheus metrics available at http://localhost:${port}/metrics`));
        startTelemetryDaemon(projectRoot);
      }

      const operator =
        process.env.USER ??
        (typeof process.getuid === "function"
          ? String(process.getuid())
          : null);
      const git = getGitContext(projectRoot);
      const claudeVersion = getClaudeCodeVersion();

      const session = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const s = sm.createSession({
          objective,
          configSnapshot: JSON.stringify(sanitizeConfigForStorage(config)),
        });
        s.operator = operator ?? null;
        s.hostname = hostname();
        s.k6sVersion = VERSION;
        s.claudeCodeVersion = claudeVersion;
        s.gitBranch = git.branch;
        s.gitSha = git.sha;
        s.gitDirty = git.dirty;
        sm.updateSession(s);
        sm.markSessionActive(s.id);

        const teamKey = loadSigningKey(khoregoDir);
        const logger = new AuditLogger(db, s.id, s.traceId, teamKey);
        logger.start();
        logger.log({
          eventType: "session_start",
          action: "session started",
          details: {
            objective,
            operator: s.operator,
            hostname: s.hostname,
            k6s_version: s.k6sVersion,
            claude_code_version: s.claudeCodeVersion,
            git_branch: s.gitBranch,
            git_sha: s.gitSha,
            git_dirty: s.gitDirty,
          },
        });
        logger.stop();

        const tracer = getTracer();
        tracer.startActiveSpan(
          "session.start",
          {
            attributes: {
              "session.id": s.id,
              "session.objective": s.objective,
              operator: s.operator ?? "",
            },
          },
          (span) => {
            span.end();
          },
        );
        recordSessionStart();

        // Auto-prune old audit data (silent, best-effort).
        const retentionDays = config.session.audit_retention_days;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        try {
          pruneAuditEvents(db, cutoff.toISOString());
        } catch {
          // Non-critical — don't block session start.
        }

        return s;
      });

      console.log(chalk.green("✓") + ` Session ${chalk.bold(session.id.slice(0, 8) + "...")} created`);

      injectClaudeMdGovernance(projectRoot, session.id);
      console.log(chalk.green("✓") + " CLAUDE.md updated with governance rules");

      registerMcpServer(projectRoot);
      registerHooks(projectRoot);
      console.log(chalk.green("✓") + " MCP server and hooks registered");

      // Atomic state file creation — prevents race if two `team start`
      // commands run concurrently (the isRunning() check above is a fast
      // path for UX; this is the actual safety net).
      if (!daemon.createState({ session_id: session.id })) {
        const raceState = daemon.readState();
        const raceSid = ((raceState.session_id as string) ?? "unknown").slice(0, 8);
        console.log(chalk.yellow(`Race detected: session ${raceSid}... was started concurrently.`));
        process.exit(1);
      }

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
    .action(async () => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      const daemon = new DaemonState(khoregoDir);
      if (!daemon.isRunning()) {
        console.log(chalk.yellow("No active session."));
        process.exit(1);
      }

      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";

      const tracer = getTracer();
      tracer.startActiveSpan("session.stop", { attributes: { "session.id": sessionId } }, (span) => {
        span.end();
      });

      withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        sm.markSessionCompleted(sessionId);
      });

      removeClaudeMdGovernance(projectRoot);
      unregisterHooks(projectRoot);
      daemon.removeState();
      stopTelemetryDaemon(projectRoot);

      console.log(chalk.green("✓") + ` Session ${sessionId.slice(0, 8)}... stopped`);
      console.log(chalk.green("✓") + " Governance removed (CLAUDE.md, hooks)");
    });

  team
    .command("resume")
    .description("Resume a previous session")
    .argument("[session-id]", "Session ID to resume (defaults to latest)")
    .action(async (sessionId?: string) => {
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
        if (config.observability?.opentelemetry?.enabled) {
          const endpoint = config.observability.opentelemetry.endpoint ?? "http://localhost:4318";
          const safeEndpoint = redactEndpointForLogs(endpoint);
          console.log(chalk.dim(`Sending traces to ${safeEndpoint}. Ensure your OTLP collector is running.`));
        }
        if (config.observability?.prometheus?.enabled) {
          const port = config.observability.prometheus.port ?? 9090;
          console.log(chalk.dim(`Prometheus metrics available at http://localhost:${port}/metrics`));
        startTelemetryDaemon(projectRoot);
        }
        const newSession = sm.createSession({
          objective: prev.objective,
          configSnapshot: JSON.stringify(sanitizeConfigForStorage(config)),
          parentSessionId: prev.id,
        });

        sm.saveContext({
          sessionId: newSession.id,
          key: "resume_context",
          value: context,
        });

        sm.markSessionActive(newSession.id);

        const tracer = getTracer();
        tracer.startActiveSpan(
          "session.start",
          {
            attributes: {
              "session.id": newSession.id,
              "session.objective": newSession.objective,
              operator: prev.operator ?? "",
            },
          },
          (span) => {
            span.end();
          },
        );
        recordSessionStart();

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

      // Atomic state file creation — same race guard as team start.
      if (!daemon.createState({ session_id: result.newSession.id })) {
        const raceState = daemon.readState();
        const raceSid = ((raceState.session_id as string) ?? "unknown").slice(0, 8);
        console.log(chalk.yellow(`Race detected: session ${raceSid}... was started concurrently.`));
        process.exit(1);
      }

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
        head: ["ID", "Objective", "State", "Started"],
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
        ]);
      }

      console.log(table.toString());
    });
}
