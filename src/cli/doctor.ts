/**
 * CLI command: k6s doctor
 *
 * Runs diagnostic checks to verify the Khoregos runtime environment
 * is healthy — native modules compiled for the right Node, etc.
 */

import { Command } from "commander";
import chalk from "chalk";
import { runAllChecks, printCheckResults } from "../engine/doctor.js";
import { output, resolveJsonOption } from "./output.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check runtime environment health (Node version, native modules)")
    .action((_opts: Record<string, unknown>, command: Command) => {
      const json = resolveJsonOption(_opts, command);
      const results = runAllChecks();
      const allOk = results.every((r) => r.ok);

      if (json) {
        output(
          {
            ok: allOk,
            checks: results.map((r) => ({
              name: r.name,
              ok: r.ok,
              message: r.message,
              ...(r.fix ? { fix: r.fix } : {}),
            })),
          },
          { json: true },
        );
        if (!allOk) process.exit(1);
        return;
      }

      console.log(chalk.bold("Khoregos Doctor"));
      console.log();
      printCheckResults(results);

      if (allOk) {
        console.log();
        console.log(chalk.green("All checks passed."));
      } else {
        console.log(chalk.red("Some checks failed. See fixes above."));
        process.exit(1);
      }
    });
}
