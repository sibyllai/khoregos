/**
 * Team management CLI commands.
 */

import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync, closeSync, constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  DaemonState,
  injectClaudeMdGovernance,
  isPluginInstalled,
  registerHooks,
  registerMcpServer,
  removeClaudeMdGovernance,
  unregisterHooks,
  unregisterMcpServer,
} from "../daemon/manager.js";
import {
  AuditLogger,
  pruneAuditEvents,
  pruneSessions,
  setWebhookDispatcher,
} from "../engine/audit.js";
import { loadSigningKey } from "../engine/signing.js";
import {
  PluginManager,
  getPluginManager,
  setPluginManager,
} from "../engine/plugins.js";
import {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  redactEndpointForLogs,
  recordSessionStart,
} from "../engine/telemetry.js";
import { loadConfig, sanitizeConfigForStorage, detectHardcodedSecrets } from "../models/config.js";
import { type Session, type SessionState, sessionDurationSeconds } from "../models/session.js";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { WebhookDispatcher } from "../engine/webhooks.js";
import { VERSION } from "../version.js";
import {
  initLangfuse,
  shutdownLangfuse,
  createSessionTrace,
  updateSessionTrace,
  scoreSession,
} from "../engine/langfuse.js";
import { notifySessionLifecycle } from "../engine/notifications.js";
import { output, resolveJsonOption } from "./output.js";

// ── Dashboard daemon helpers ────────────────────────────────────────

export function dashboardPidFile(projectRoot: string): string {
  return path.join(projectRoot, ".khoregos", "dashboard.pid");
}

export function readDashboardPid(projectRoot: string): number | null {
  const pidPath = dashboardPidFile(projectRoot);
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearDashboardPid(projectRoot: string): void {
  const pidPath = dashboardPidFile(projectRoot);
  try {
    unlinkSync(pidPath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function stopDashboardDaemon(projectRoot: string): void {
  const pid = readDashboardPid(projectRoot);
  if (!pid) {
    clearDashboardPid(projectRoot);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.error(`Warning: Failed to stop dashboard daemon (pid ${pid}): ${(e as Error).message}.`);
    }
  } finally {
    clearDashboardPid(projectRoot);
  }
}

/**
 * Generate a push token, start the dashboard as a detached process,
 * and return the token so it can be stored in daemon state.
 */
export function startDashboardDaemon(projectRoot: string, port: number, sessionId: string): string {
  stopDashboardDaemon(projectRoot);
  const pushToken = randomBytes(24).toString("hex");
  const child = spawn(
    "k6s",
    ["dashboard", "--no-open", "--session", sessionId, "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, K6S_DASHBOARD_PUSH_TOKEN: pushToken },
    },
  );
  child.unref();
  // Write PID file atomically with O_CREAT|O_EXCL to prevent symlink attacks.
  const pidPath = dashboardPidFile(projectRoot);
  try { unlinkSync(pidPath); } catch { /* ignore ENOENT */ }
  const fd = openSync(pidPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  writeSync(fd, `${child.pid}\n`);
  closeSync(fd);
  return pushToken;
}

const SESSION_START_ACTION_OBJECTIVE_MAX_LENGTH = 200;

function formatSessionStartAction(objective: string): string {
  const normalizedObjective = objective.replace(/\s+/g, " ").trim();
  const truncatedObjective = normalizedObjective.length > SESSION_START_ACTION_OBJECTIVE_MAX_LENGTH
    ? `${normalizedObjective.slice(0, SESSION_START_ACTION_OBJECTIVE_MAX_LENGTH - 3)}...`
    : normalizedObjective;
  return `session started: ${truncatedObjective}`;
}

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

function hasRegisteredHooks(hooks: unknown): boolean {
  if (!hooks) return false;
  if (Array.isArray(hooks)) {
    return hooks.length > 0;
  }
  if (typeof hooks !== "object") return false;
  const hookGroups = Object.values(hooks as Record<string, unknown>);
  if (hookGroups.length === 0) return false;
  return hookGroups.some((group) => {
    if (!Array.isArray(group) || group.length === 0) return false;
    return group.some((entry) => {
      const nested = (entry as Record<string, unknown>).hooks;
      return Array.isArray(nested) && nested.length > 0;
    });
  });
}

function readRegistrationStatus(projectRoot: string): { mcpRegistered: boolean; hooksRegistered: boolean } {
  if (isPluginInstalled(projectRoot)) {
    return { mcpRegistered: true, hooksRegistered: true };
  }
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsFile)) {
    return { mcpRegistered: false, hooksRegistered: false };
  }
  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
    const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
    return {
      mcpRegistered: Boolean(mcpServers?.khoregos),
      hooksRegistered: hasRegisteredHooks(settings.hooks),
    };
  } catch {
    return { mcpRegistered: false, hooksRegistered: false };
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
    .argument("[objective]", "What the team will work on (optional — defaults to git branch)")
    .option("-r, --run", "Launch Claude Code with the objective as prompt")
    .option("-d, --dashboard", "Launch the real-time audit dashboard")
    .action(async (objectiveArg: string | undefined, opts: { run?: boolean; dashboard?: boolean }) => {
      const projectRoot = process.cwd();
      // Resolve objective: explicit arg wins, else git branch, else generic.
      const git = getGitContext(projectRoot);
      const hadExplicitObjective = typeof objectiveArg === "string" && objectiveArg.trim().length > 0;
      const objective = hadExplicitObjective
        ? objectiveArg!
        : git.branch
          ? `session on branch ${git.branch}`
          : "ad-hoc session (no objective)";
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
      const hasStrictEnforcement = config.boundaries.some(
        (boundary) => boundary.enforcement === "strict",
      );
      if (hasStrictEnforcement) {
        try {
          execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: projectRoot,
            stdio: "pipe",
          });
        } catch {
          console.error(
            chalk.red(
              "Error: strict boundary enforcement requires a git repository.",
            ),
          );
          process.exit(1);
        }
      }

      if (config.observability?.webhooks?.length) {
        setWebhookDispatcher(new WebhookDispatcher(config.observability.webhooks));
      } else {
        setWebhookDispatcher(null);
      }
      const prometheusEnabled = config.observability?.prometheus?.enabled === true;

      if (config.observability?.opentelemetry?.enabled) {
        const endpoint = config.observability.opentelemetry.endpoint ?? "http://localhost:4318";
        const safeEndpoint = redactEndpointForLogs(endpoint);
        console.log(chalk.dim(`Sending traces to ${safeEndpoint}. Ensure your OTLP collector is running.`));
      }
      if (prometheusEnabled) {
        const port = config.observability.prometheus.port ?? 9090;
        console.log(chalk.dim(`Prometheus metrics available at http://localhost:${port}/metrics`));
        startTelemetryDaemon(projectRoot);
      }

      // When the Prometheus daemon is running it owns all metric export.
      // The CLI process only needs OTLP tracing in that case.
      initTelemetry(config, { skipMetrics: prometheusEnabled });
      initLangfuse(config);

      // Warn about hardcoded secrets in the config file.
      const secretWarnings = detectHardcodedSecrets(config);
      for (const warning of secretWarnings) {
        console.error(chalk.yellow(`⚠ Security: ${warning}`));
      }

      const operator =
        process.env.USER ??
        (typeof process.getuid === "function"
          ? String(process.getuid())
          : null);
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
          action: formatSessionStartAction(objective),
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

        createSessionTrace({
          sessionId: s.id,
          objective,
          operator: s.operator,
          gitBranch: s.gitBranch,
          gitSha: s.gitSha,
          traceId: s.traceId,
        });

        // Auto-prune old audit/session data (best-effort).
        const auditCutoff = new Date();
        auditCutoff.setDate(
          auditCutoff.getDate() - config.session.audit_retention_days,
        );
        const sessionCutoff = new Date();
        sessionCutoff.setDate(
          sessionCutoff.getDate() - config.session.session_retention_days,
        );
        try {
          const auditResult = pruneAuditEvents(db, auditCutoff.toISOString());
          const sessionResult = pruneSessions(db, sessionCutoff.toISOString());
          if (
            auditResult.eventsDeleted > 0
            || sessionResult.sessionsPruned > 0
          ) {
            logger.log({
              eventType: "system",
              action: `auto-prune: ${auditResult.eventsDeleted} events, ${sessionResult.sessionsPruned} sessions`,
              details: {
                audit_retention_days: config.session.audit_retention_days,
                session_retention_days: config.session.session_retention_days,
                events_deleted: auditResult.eventsDeleted,
                sessions_pruned: sessionResult.sessionsPruned,
              },
              severity: "info",
            });
          }
        } catch {
          // Non-critical — don't block session start.
        }
        logger.stop();

        return s;
      });

      const pluginManaged = isPluginInstalled(projectRoot);
      if (config.plugins.length > 0) {
        const pluginManager = new PluginManager();
        await pluginManager.loadPlugins(config.plugins, session.id, projectRoot);
        setPluginManager(pluginManager);
        await pluginManager.callSessionStart();
      } else {
        setPluginManager(null);
      }

      console.log(chalk.green("✓") + ` Session ${chalk.bold(session.id.slice(0, 8) + "...")} created`);

      notifySessionLifecycle("session_start", config.notifications, {
        sessionId: session.id,
        objective,
      });

      injectClaudeMdGovernance(projectRoot, {
        sessionId: session.id,
        objective,
        traceId: session.traceId ?? "unknown",
        signingEnabled: true,
        boundaries: config.boundaries,
      });
      console.log(chalk.green("✓") + " CLAUDE.md updated with session governance context");

      if (pluginManaged) {
        console.log(chalk.green("✓") + " Plugin-managed hooks/MCP detected");
      } else {
        registerMcpServer(projectRoot);
        registerHooks(projectRoot);
        console.log(chalk.green("✓") + " MCP server and hooks registered");
      }

      // Atomic state file creation — prevents race if two `team start`
      // commands run concurrently (the isRunning() check above is a fast
      // path for UX; this is the actual safety net).
      const daemonStateData: Record<string, unknown> = { session_id: session.id };
      if (opts.dashboard) {
        daemonStateData.dashboard_port = config.dashboard?.port ?? 6100;
      }
      if (!daemon.createState(daemonStateData)) {
        const raceState = daemon.readState();
        const raceSid = ((raceState.session_id as string) ?? "unknown").slice(0, 8);
        console.log(chalk.yellow(`Race detected: session ${raceSid}... was started concurrently.`));
        process.exit(1);
      }

      // Dashboard daemon.
      if (opts.dashboard) {
        const dashPort = config.dashboard?.port ?? 6100;
        const pushToken = startDashboardDaemon(projectRoot, dashPort, session.id);
        // Persist token so hooks can authenticate pushes.
        daemon.writeState({ ...daemon.readState(), dashboard_push_token: pushToken });
        const dashUrl = `http://${config.dashboard?.host ?? "localhost"}:${dashPort}`;
        console.log(chalk.green("✓") + ` Dashboard at ${chalk.bold.cyan(dashUrl)}`);
        try {
          const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          execFileSync(openCmd, [dashUrl], { stdio: "ignore" });
        } catch {
          // Best-effort.
        }
      }

      const objectiveOneline = objective.replace(/\s+/g, " ").trim();
      console.log();
      console.log(`${chalk.bold("Objective:")} ${objectiveOneline}`);
      console.log();

      if (opts.run) {
        console.log(chalk.bold("Launching Claude Code..."));
        console.log();
        try {
          // When no explicit objective was given, launch Claude with no
          // initial prompt — the user will type their own.
          const claudeArgs = hadExplicitObjective ? [objective] : [];
          execFileSync("claude", claudeArgs, { stdio: "inherit" });
        } catch {
          console.error(chalk.red("Claude Code not found."));
          console.error("Make sure 'claude' is in your PATH.");
          process.exit(1);
        }
      } else {
        console.log(chalk.green("Session ready!") + " Now run:");
        console.log();
        if (hadExplicitObjective) {
          const escaped = objectiveOneline.replace(/'/g, "'\\''");
          console.log(`  ${chalk.cyan.bold(`claude '${escaped}'`)}`);
        } else {
          console.log(`  ${chalk.cyan.bold("claude")}`);
        }
        console.log();
        console.log("When done, run " + chalk.bold("k6s team stop") + " to end the session.");
      }
      await shutdownLangfuse();
      await shutdownTelemetry();
    });

  team
    .command("stop")
    .description("Stop the current agent team session")
    .action(async () => {
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");
      const configFile = path.join(projectRoot, "k6s.yaml");

      const daemon = new DaemonState(khoregoDir);
      if (!daemon.isRunning()) {
        console.log(chalk.yellow("No active session."));
        process.exit(1);
      }

      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";

      // Initialize tracing and webhooks so the session.stop span and any
      // audit events logged during teardown are dispatched correctly.
      if (existsSync(configFile)) {
        const config = loadConfig(configFile);
        const prometheusEnabled = config.observability?.prometheus?.enabled === true;
        initTelemetry(config, { skipMetrics: prometheusEnabled });
        initLangfuse(config);
        if (config.observability?.webhooks?.length) {
          setWebhookDispatcher(new WebhookDispatcher(config.observability.webhooks));
        }

        // Warn about hardcoded secrets on stop as well.
        const secretWarnings = detectHardcodedSecrets(config);
        for (const warning of secretWarnings) {
          console.error(chalk.yellow(`⚠ Security: ${warning}`));
        }
      }

      const tracer = getTracer();
      tracer.startActiveSpan("session.stop", { attributes: { "session.id": sessionId } }, (span) => {
        span.end();
      });

      withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        sm.markSessionCompleted(sessionId);

        // Score the session trace with total cost if Langfuse is active.
        updateSessionTrace({
          sessionId,
          metadata: { state: "completed", ended_at: new Date().toISOString() },
        });
        const costRow = db.fetchOne(
          "SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM cost_records WHERE session_id = ?",
          [sessionId],
        );
        const totalCost = Number(costRow?.total ?? 0);
        if (totalCost > 0) {
          scoreSession({
            sessionId,
            name: "total_cost_usd",
            value: totalCost,
            comment: `Session cost: $${totalCost.toFixed(4)}`,
          });
        }
      });

      const pluginManager = getPluginManager();
      if (pluginManager) {
        await pluginManager.callSessionStop();
        setPluginManager(null);
      }

      const pluginManaged = isPluginInstalled(projectRoot);
      removeClaudeMdGovernance(projectRoot);
      if (!pluginManaged) {
        unregisterHooks(projectRoot);
        unregisterMcpServer(projectRoot);
      }
      daemon.removeState();
      stopTelemetryDaemon(projectRoot);
      stopDashboardDaemon(projectRoot);

      setWebhookDispatcher(null);
      await shutdownLangfuse();
      await shutdownTelemetry();

      // Load notifications config for desktop notification.
      const stopConfig = existsSync(configFile)
        ? loadConfig(configFile)
        : null;
      notifySessionLifecycle(
        "session_complete",
        stopConfig?.notifications ?? { session_lifecycle: true, desktop: true, dashboard: true },
        { sessionId },
      );

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

      const config = loadConfig(configFile);
      const hasStrictEnforcement = config.boundaries.some(
        (boundary) => boundary.enforcement === "strict",
      );
      if (hasStrictEnforcement) {
        try {
          execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: projectRoot,
            stdio: "pipe",
          });
        } catch {
          console.error(
            chalk.red(
              "Error: strict boundary enforcement requires a git repository.",
            ),
          );
          process.exit(1);
        }
      }

      if (config.observability?.webhooks?.length) {
        setWebhookDispatcher(new WebhookDispatcher(config.observability.webhooks));
      } else {
        setWebhookDispatcher(null);
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);

        let prev: Session | null = null;
        if (sessionId && sessionId !== "latest") {
          prev = sm.getSession(sessionId);
        } else {
          const sessions = sm.listSessions({ limit: 1 });
          prev = sessions[0] ?? null;
        }

        if (!prev) return null;

        const context = sm.generateResumeContext(prev.id);
        const prometheusEnabled = config.observability?.prometheus?.enabled === true;

        if (config.observability?.opentelemetry?.enabled) {
          const endpoint = config.observability.opentelemetry.endpoint ?? "http://localhost:4318";
          const safeEndpoint = redactEndpointForLogs(endpoint);
          console.log(chalk.dim(`Sending traces to ${safeEndpoint}. Ensure your OTLP collector is running.`));
        }
        if (prometheusEnabled) {
          const port = config.observability.prometheus.port ?? 9090;
          console.log(chalk.dim(`Prometheus metrics available at http://localhost:${port}/metrics`));
          startTelemetryDaemon(projectRoot);
        }

        initTelemetry(config, { skipMetrics: prometheusEnabled });
        initLangfuse(config);

        // Warn about hardcoded secrets.
        const secretWarnings = detectHardcodedSecrets(config);
        for (const w of secretWarnings) {
          console.error(chalk.yellow(`⚠ Security: ${w}`));
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

        createSessionTrace({
          sessionId: newSession.id,
          objective: newSession.objective,
          operator: prev.operator,
          gitBranch: prev.gitBranch,
          gitSha: prev.gitSha,
          traceId: newSession.traceId,
        });

        const teamKey = loadSigningKey(khoregoDir);
        const logger = new AuditLogger(db, newSession.id, newSession.traceId, teamKey);
        logger.start();
        logger.log({
          eventType: "session_start",
          action: formatSessionStartAction(newSession.objective),
          details: {
            objective: newSession.objective,
            resumed_from_session_id: prev.id,
          },
        });
        logger.stop();

        return { prev, newSession, context };
      });

      if (!result) {
        console.log(chalk.yellow("No session found to resume."));
        process.exit(1);
      }

      if (config.plugins.length > 0) {
        const pluginManager = new PluginManager();
        await pluginManager.loadPlugins(config.plugins, result.newSession.id, projectRoot);
        setPluginManager(pluginManager);
        await pluginManager.callSessionStart();
      } else {
        setPluginManager(null);
      }

      console.log(chalk.green("✓") + ` Resuming from session ${chalk.bold(result.prev.id.slice(0, 8) + "...")}`);
      console.log(`${chalk.bold("Objective:")} ${result.prev.objective}`);

      notifySessionLifecycle("session_start", config.notifications, {
        sessionId: result.newSession.id,
        objective: result.newSession.objective,
      });

      const pluginManaged = isPluginInstalled(projectRoot);
      injectClaudeMdGovernance(projectRoot, {
        sessionId: result.newSession.id,
        objective: result.newSession.objective,
        traceId: result.newSession.traceId ?? "unknown",
        signingEnabled: true,
        boundaries: config.boundaries,
        resumeContext: result.context,
      });
      if (!pluginManaged) {
        registerMcpServer(projectRoot);
        registerHooks(projectRoot);
      }

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
      await shutdownLangfuse();
      await shutdownTelemetry();
    });

  team
    .command("status")
    .description("Show current team session status")
    .option("--json", "Output in JSON format")
    .action((opts: { json?: boolean }, command: Command) => {
      const json = resolveJsonOption(opts, command);
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      const daemon = new DaemonState(khoregoDir);
      const daemonRunning = daemon.isRunning();
      const registration = readRegistrationStatus(projectRoot);
      if (!daemonRunning) {
        if (json) {
          output(
            {
              active_session: null,
              daemon_running: false,
              mcp_registered: registration.mcpRegistered,
              hooks_registered: registration.hooksRegistered,
            },
            { json: true },
          );
          return;
        }
        console.log(chalk.dim("No active session"));
        return;
      }

      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";

      withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const session = sm.getSession(sessionId);
        const agents = session ? sm.listAgents(sessionId) : [];

        if (json) {
          output(
            {
              active_session: session
                ? {
                    session_id: session.id,
                    objective: session.objective,
                    state: session.state,
                    started_at: session.startedAt,
                    operator: session.operator,
                    git_branch: session.gitBranch,
                    trace_id: session.traceId,
                  }
                : {
                    session_id: sessionId,
                    objective: null,
                    state: "active",
                    started_at: null,
                    operator: null,
                    git_branch: null,
                    trace_id: null,
                  },
              daemon_running: true,
              mcp_registered: registration.mcpRegistered,
              hooks_registered: registration.hooksRegistered,
            },
            { json: true },
          );
          return;
        }

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
    .option("--json", "Output in JSON format")
    .action((opts: { limit: string; json?: boolean }, command: Command) => {
      const json = resolveJsonOption(opts, command);
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");
      const dbPath = path.join(khoregoDir, "k6s.db");

      if (!existsSync(dbPath)) {
        if (json) {
          output({ sessions: [] }, { json: true });
          return;
        }
        console.log(chalk.yellow("No sessions found."));
        return;
      }

      const sessions = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const rows = sm.listSessions({ limit: parseInt(opts.limit, 10) });
        return rows.map((s) => {
          const eventCount = Number(
            db.fetchOne("SELECT COUNT(*) as count FROM audit_events WHERE session_id = ?", [s.id])?.count ?? 0,
          );
          return { session: s, eventCount };
        });
      });

      if (!sessions.length) {
        if (json) {
          output({ sessions: [] }, { json: true });
          return;
        }
        console.log(chalk.dim("No sessions found."));
        return;
      }

      if (json) {
        output(
          {
            sessions: sessions.map(({ session: s, eventCount }) => ({
              id: s.id,
              objective: s.objective,
              state: s.state,
              started_at: s.startedAt,
              ended_at: s.endedAt,
              duration_seconds: sessionDurationSeconds(s),
              operator: s.operator,
              event_count: eventCount,
            })),
          },
          { json: true },
        );
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

      for (const { session: s } of sessions) {
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
