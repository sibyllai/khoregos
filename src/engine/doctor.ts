/**
 * Diagnostic checks for Khoregos runtime health.
 *
 * Used by `k6s doctor` and auto-invoked after `k6s init` to catch
 * native-module / Node.js version mismatches before they bite.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  fix?: string;
}

/**
 * Resolve the directory where the k6s package is installed.
 * Works for both global (`npm -g`) and local installs.
 */
function getPackageRoot(): string {
  // __dirname equivalent for ESM — walk up from this compiled file.
  // dist/engine/doctor.js → package root
  return path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
}

/**
 * Check that better-sqlite3's native addon was compiled for the
 * currently-running Node.js version.
 */
export function checkNativeModules(): CheckResult {
  const name = "native-modules";
  try {
    // Attempt to load better-sqlite3 — this is the exact call that fails
    // when NODE_MODULE_VERSION doesn't match.
    require("better-sqlite3");
    return { name, ok: true, message: "better-sqlite3 native module loads OK" };
  } catch {
    // require() isn't available in ESM, so fall back to actually trying
    // to open a throwaway in-memory database via the Db class path.
  }

  // ESM path: attempt a dynamic import and instantiation.
  try {
    // We can't dynamic-import synchronously, so instead shell out to
    // Node itself for a quick probe.  This is the most reliable way to
    // detect the mismatch without duplicating the native-load logic.
    const probe = `
      try {
        const Database = require('better-sqlite3');
        new Database(':memory:');
        process.exit(0);
      } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
      }
    `;
    execFileSync(process.execPath, ["--eval", probe], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5000,
      cwd: getPackageRoot(),
      env: { ...process.env, NODE_PATH: path.join(getPackageRoot(), "node_modules") },
    });
    return { name, ok: true, message: "better-sqlite3 native module loads OK" };
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: Buffer }).stderr)
        : "";

    const moduleVersionMatch = stderr.match(
      /compiled against.*NODE_MODULE_VERSION (\d+).*requires.*NODE_MODULE_VERSION (\d+)/,
    );

    let message: string;
    if (moduleVersionMatch) {
      message =
        `better-sqlite3 was compiled for NODE_MODULE_VERSION ${moduleVersionMatch[1]}, ` +
        `but the current Node.js (${process.version}) requires ${moduleVersionMatch[2]}`;
    } else {
      message = `better-sqlite3 native module failed to load: ${stderr || "unknown error"}`;
    }

    const packageRoot = getPackageRoot();
    const fix = [
      "Rebuild native modules for your current Node.js version:",
      "",
      `  cd ${packageRoot}`,
      "  npm rebuild better-sqlite3",
      "",
      "Or reinstall Khoregos globally:",
      "",
      "  npm install -g @sibyllai/khoregos",
    ].join("\n");

    return { name, ok: false, message, fix };
  }
}

/** Check that the Node.js version meets the minimum requirement. */
export function checkNodeVersion(): CheckResult {
  const name = "node-version";
  const major = parseInt(process.version.slice(1), 10);
  if (major >= 20) {
    return { name, ok: true, message: `Node.js ${process.version} meets minimum (>=20)` };
  }
  return {
    name,
    ok: false,
    message: `Node.js ${process.version} is below the minimum required (>=20)`,
    fix: "Upgrade Node.js to version 20 or later: https://nodejs.org/",
  };
}

/** Run all diagnostic checks and return results. */
export function runAllChecks(): CheckResult[] {
  return [checkNodeVersion(), checkNativeModules()];
}

/** Pretty-print check results to the console. Returns true if all passed. */
export function printCheckResults(results: CheckResult[]): boolean {
  let allOk = true;
  for (const r of results) {
    if (r.ok) {
      console.log(`${chalk.green("✓")} ${r.message}`);
    } else {
      allOk = false;
      console.log(`${chalk.red("✗")} ${r.message}`);
      if (r.fix) {
        console.log();
        console.log(chalk.yellow("  Fix:"));
        for (const line of r.fix.split("\n")) {
          console.log(`  ${line}`);
        }
        console.log();
      }
    }
  }
  return allOk;
}
