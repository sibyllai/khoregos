import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { generateCheckpoint } from "../engine/checkpoint.js";
import { withDb, resolveSessionId } from "./shared.js";
import { StateManager } from "../engine/state.js";
import { AuditLogger } from "../engine/audit.js";
import { loadSigningKey } from "../engine/signing.js";

export function registerComplianceCommands(program: Command): void {
  const compliance = program
    .command("compliance")
    .description("Compliance attestation and checkpoint tools");

  compliance
    .command("checkpoint")
    .description("Generate a compliance checkpoint attestation")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-o, --output <file>", "Write attestation to file (stdout if omitted)")
    .action((opts: { session: string; output?: string }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;
        const checkpoint = generateCheckpoint(db, sessionId, projectRoot);

        const key = loadSigningKey(path.join(projectRoot, ".khoregos"));
        const session = sm.getSession(sessionId);
        const logger = new AuditLogger(db, sessionId, session?.traceId, key);
        logger.start();
        logger.log({
          eventType: "system",
          action: `compliance checkpoint: chain ${checkpoint.chainIntegrity.valid ? "valid" : "invalid"}, ${checkpoint.violations.total} violations, ${checkpoint.gateEvents.total} gate events`,
          details: {
            chain_valid: checkpoint.chainIntegrity.valid,
            events_checked: checkpoint.chainIntegrity.eventsChecked,
            violations_total: checkpoint.violations.total,
            gate_events_total: checkpoint.gateEvents.total,
          },
          severity: "info",
        });
        logger.stop();
        return checkpoint;
      });

      if (!result) {
        console.log(chalk.yellow("No session found."));
        return;
      }

      if (opts.output) {
        writeFileSync(opts.output, result.attestation);
        console.log(chalk.green("✓") + ` Wrote compliance checkpoint to ${opts.output}`);
      } else {
        console.log(result.attestation);
      }
    });
}
