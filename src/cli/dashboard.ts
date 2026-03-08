/**
 * CLI command for the real-time audit dashboard.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../models/config.js";
import { DaemonState } from "../daemon/manager.js";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { DashboardServer } from "../engine/dashboard.js";

export function registerDashboardCommands(program: Command): void {
  program
    .command("dashboard")
    .description("Launch the real-time audit dashboard")
    .option("-p, --port <number>", "HTTP port", "6100")
    .option("-H, --host <host>", "Host to bind to", "localhost")
    .option("--no-open", "Do not open browser automatically")
    .option("-s, --session <id>", "Session ID (default: latest)", "latest")
    .action(async (opts: {
      port: string;
      host: string;
      open: boolean;
      session: string;
    }) => {
      const projectRoot = process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");
      const khoregoDir = path.join(projectRoot, ".khoregos");
      const dbPath = path.join(khoregoDir, "k6s.db");

      if (!existsSync(configFile)) {
        console.error(
          chalk.red("Not initialized.") +
            " Run " +
            chalk.bold("k6s init") +
            " first.",
        );
        process.exit(1);
      }

      if (!existsSync(dbPath)) {
        console.error(
          chalk.red("No database found.") +
            " Run " +
            chalk.bold("k6s team start") +
            " first.",
        );
        process.exit(1);
      }

      const config = loadConfig(configFile);
      const port = parseInt(opts.port, 10) || (config.dashboard?.port ?? 6100);
      const host = opts.host || (config.dashboard?.host ?? "localhost");

      // Resolve session ID.
      let sessionId = opts.session;
      const db = new Db(dbPath);
      db.connect();

      if (sessionId === "latest") {
        // Check daemon state first.
        const daemon = new DaemonState(khoregoDir);
        if (daemon.isRunning()) {
          const state = daemon.readState();
          sessionId = (state.session_id as string) ?? "";
        }

        if (!sessionId || sessionId === "latest") {
          const sm = new StateManager(db, projectRoot);
          const latest = sm.getLatestSession();
          if (latest) {
            sessionId = latest.id;
          } else {
            db.close();
            console.error(chalk.red("No sessions found."));
            process.exit(1);
          }
        }
      }

      const dashboardServer = new DashboardServer({
        db,
        config,
        sessionId,
        port,
        host,
      });

      const actualPort = await dashboardServer.start();
      const url = `http://${host}:${actualPort}`;

      console.log(
        chalk.green("Dashboard running at ") + chalk.bold.cyan(url),
      );
      console.log(
        chalk.dim(`Session: ${sessionId.slice(0, 8)}...`),
      );
      console.log(chalk.dim("Press Ctrl+C to stop."));

      // Open browser.
      if (opts.open) {
        try {
          const openCmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          execFileSync(openCmd, [url], { stdio: "ignore" });
        } catch {
          // Browser open is best-effort.
        }
      }

      // Block until SIGINT/SIGTERM.
      const shutdown = async () => {
        console.log(chalk.dim("\nShutting down dashboard..."));
        await dashboardServer.stop();
        db.close();
        process.exit(0);
      };

      process.on("SIGINT", () => { void shutdown(); });
      process.on("SIGTERM", () => { void shutdown(); });
    });
}
