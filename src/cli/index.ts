/**
 * Main CLI entry point for Khoregos.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DaemonState } from "../daemon/manager.js";
import { generateSigningKey } from "../engine/signing.js";
import {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  redactEndpointForLogs,
  recordSessionStart,
  recordAuditEvent,
  recordActiveAgentDelta,
  recordBoundaryViolation,
  recordToolDurationSeconds,
} from "../engine/telemetry.js";
import {
  generateDefaultConfig,
  K6sConfigSchema,
  loadConfig,
  saveConfig,
} from "../models/config.js";
import { K6sServer } from "../mcp/server.js";
import { Db } from "../store/db.js";
import { registerTeamCommands } from "./team.js";
import { registerSessionCommands } from "./session.js";
import { registerAuditCommands } from "./audit.js";
import { registerHookCommands } from "./hook.js";
import { VERSION } from "../version.js";

const program = new Command();

program
  .name("k6s")
  .description("Khoregos: Enterprise governance layer for Claude Code Agent Teams")
  .version(VERSION);

// Subcommands
registerTeamCommands(program);
registerSessionCommands(program);
registerAuditCommands(program);
registerHookCommands(program);

// init
program
  .command("init")
  .description("Initialize Khoregos in the current project")
  .option("-n, --name <name>", "Project name (defaults to directory name)")
  .option("-f, --force", "Overwrite existing configuration")
  .action((opts: { name?: string; force?: boolean }) => {
    const projectRoot = process.cwd();
    const khoregoDir = path.join(projectRoot, ".khoregos");
    const configFile = path.join(projectRoot, "k6s.yaml");

    if (existsSync(configFile) && !opts.force) {
      console.log(
        chalk.yellow("Project already initialized.") +
          " Use --force to overwrite.",
      );
      process.exit(1);
    }

    const projectName = opts.name ?? path.basename(projectRoot);

    mkdirSync(khoregoDir, { recursive: true });
    console.log(chalk.green("✓") + ` Created .khoregos/`);

    const config = generateDefaultConfig(projectName);
    saveConfig(config, configFile);
    console.log(chalk.green("✓") + ` Created k6s.yaml`);

    if (generateSigningKey(khoregoDir)) {
      console.log(chalk.green("✓") + ` Created .khoregos/signing.key`);
    }

    const gitignore = path.join(khoregoDir, ".gitignore");
    writeFileSync(
      gitignore,
      "# Ignore database, daemon state, and signing key\n*.db\n*.db-*\ndaemon.*\nsigning.key\n",
    );
    console.log(chalk.green("✓") + ` Created .khoregos/.gitignore`);

    console.log();
    console.log(chalk.bold.green(`Khoregos initialized for ${projectName}`));
    console.log();
    console.log("Next steps:");
    console.log("  1. Edit k6s.yaml to configure boundaries and audit rules");
    console.log(
      `  2. Run ${chalk.bold('k6s team start "your objective"')} to begin a session`,
    );
  });

// telemetry smoke
program
  .command("telemetry")
  .description("OpenTelemetry diagnostics")
  .argument("[action]", "Action: smoke")
  .option("--project-root <path>", "Project root to load k6s.yaml from")
  .action(async (action?: string, opts?: { projectRoot?: string }) => {
    const cmd = action ?? "smoke";
    if (cmd === "smoke") {
      const endpoint = process.env.K6S_OTEL_ENDPOINT ?? "http://localhost:4318";
      const config = K6sConfigSchema.parse({
        project: { name: "smoke" },
        observability: {
          opentelemetry: { enabled: true, endpoint },
        },
      });
      initTelemetry(config);
      const tracer = getTracer();
      tracer.startActiveSpan(
        "smoke_test",
        { attributes: { smoke: "true" } },
        (span) => {
          span.end();
        },
      );
      await shutdownTelemetry();
      const safeEndpoint = redactEndpointForLogs(endpoint);
      console.log(chalk.green("Smoke trace sent."));
      console.log(chalk.dim(`Endpoint: ${safeEndpoint}`));
      console.log(chalk.dim("In Jaeger, select service 'khoregos' and look for span 'smoke_test'."));
      return;
    }

    if (cmd === "serve") {
      const projectRoot = opts?.projectRoot ?? process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");
      if (!existsSync(configFile)) {
        console.error(chalk.red(`No k6s.yaml found at ${configFile}.`));
        process.exit(1);
      }
      const config = loadConfig(configFile);
      initTelemetry(config);
      const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
      db.connect();

      let lastRowId = 0;
      const applyAuditMetrics = (): void => {
        const rows = db.fetchAll(
          `SELECT rowid, sequence, event_type, severity, details
           FROM audit_events
           WHERE rowid > ?
           ORDER BY rowid ASC`,
          [lastRowId],
        );
        for (const row of rows) {
          const rowId = Number(row.rowid ?? 0);
          const sequence = Number(row.sequence ?? 0);
          const eventType = String(row.event_type ?? "log");
          const severity = String(row.severity ?? "info");
          const detailsRaw = typeof row.details === "string" ? row.details : null;
          let details: Record<string, unknown> | null = null;
          if (detailsRaw) {
            try {
              details = JSON.parse(detailsRaw) as Record<string, unknown>;
            } catch {
              details = null;
            }
          }

          recordAuditEvent(eventType, severity);
          if (eventType === "session_start") {
            recordSessionStart();
          } else if (eventType === "agent_spawn") {
            recordActiveAgentDelta(1);
          } else if (eventType === "agent_complete") {
            recordActiveAgentDelta(-1);
          } else if (eventType === "boundary_violation") {
            const violationType =
              (details?.violation_type as string | undefined) ?? "unknown";
            recordBoundaryViolation(violationType);
          } else if (eventType === "tool_use") {
            const durationMs = details?.duration_ms;
            if (typeof durationMs === "number" && durationMs >= 0) {
              recordToolDurationSeconds(durationMs / 1000);
            }
          }

          if (rowId > lastRowId) {
            lastRowId = rowId;
          }
        }
      };

      applyAuditMetrics();
      const interval = setInterval(() => {
        applyAuditMetrics();
      }, 1000);
      const shutdown = async () => {
        clearInterval(interval);
        db.close();
        await shutdownTelemetry();
        process.exit(0);
      };
      process.on("SIGTERM", () => {
        void shutdown();
      });
      process.on("SIGINT", () => {
        void shutdown();
      });
      return;
    }

    console.error(chalk.red(`Unknown action: ${cmd}. Use 'smoke' or 'serve'.`));
    process.exit(1);
  });

// status
program
  .command("status")
  .description("Show current Khoregos status")
  .action(() => {
    const projectRoot = process.cwd();
    const configFile = path.join(projectRoot, "k6s.yaml");

    if (!existsSync(configFile)) {
      console.log(
        chalk.yellow("Not initialized.") +
          " Run " +
          chalk.bold("k6s init") +
          " first.",
      );
      process.exit(1);
    }

    console.log(`${chalk.bold("Project:")} ${path.basename(projectRoot)}`);
    console.log(`${chalk.bold("Config:")} ${configFile}`);

    const daemon = new DaemonState(path.join(projectRoot, ".khoregos"));
    if (daemon.isRunning()) {
      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? "unknown";
      console.log(`${chalk.bold("Status:")} ${chalk.green("Active")}`);
      console.log(`${chalk.bold("Session:")} ${sessionId}`);
    } else {
      console.log(`${chalk.bold("Status:")} ${chalk.dim("Inactive")}`);
    }
  });

// mcp serve
program
  .command("mcp")
  .description("MCP server commands")
  .argument("<action>", "Action: serve")
  .option("--project-root <path>", "Project root to serve from")
  .action((action: string, opts: { projectRoot?: string }) => {
    if (action === "serve") {
      runMcpServer(opts.projectRoot);
    } else {
      console.error(chalk.red(`Unknown action: ${action}`));
      process.exit(1);
    }
  });

function runMcpServer(projectRootArg?: string): void {
  const projectRoot = projectRootArg ?? process.cwd();
  const configFile = path.join(projectRoot, "k6s.yaml");

  let config;
  if (existsSync(configFile)) {
    config = loadConfig(configFile);
  } else {
    config = generateDefaultConfig(path.basename(projectRoot));
  }

  let sessionId = process.env.K6S_SESSION_ID;
  if (!sessionId) {
    const daemon = new DaemonState(path.join(projectRoot, ".khoregos"));
    const state = daemon.readState();
    sessionId = (state.session_id as string) ?? "default";
  }

  initTelemetry(config);
  if (sessionId !== "default") {
    recordSessionStart();
  }

  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();

  const server = new K6sServer(db, config, sessionId, projectRoot);
  server.runStdio()
    .then(async () => {
      await shutdownTelemetry();
      db.close();
    })
    .catch(async (err) => {
      console.error("MCP server error:", err);
      await shutdownTelemetry();
      db.close();
      process.exit(1);
    });
}

program.parse();
