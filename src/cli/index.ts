/**
 * Main CLI entry point for Khoregos.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { DaemonState } from "../daemon/manager.js";
import { generateSigningKey } from "../engine/signing.js";
import { generateDefaultConfig, loadConfig, saveConfig } from "../models/config.js";
import { K6sServer } from "../mcp/server.js";
import { Db } from "../store/db.js";
import { registerTeamCommands } from "./team.js";
import { registerSessionCommands } from "./session.js";
import { registerAuditCommands } from "./audit.js";
import { registerHookCommands } from "./hook.js";

const VERSION = "0.3.0";

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
  .action((action: string) => {
    if (action === "serve") {
      runMcpServer();
    } else {
      console.error(chalk.red(`Unknown action: ${action}`));
      process.exit(1);
    }
  });

function runMcpServer(): void {
  const projectRoot = process.cwd();
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

  const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
  db.connect();

  const server = new K6sServer(db, config, sessionId, projectRoot);
  server.runStdio().catch((err) => {
    console.error("MCP server error:", err);
    db.close();
    process.exit(1);
  });
}

program.parse();
