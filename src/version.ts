/**
 * Single source of truth for the Khoregos version.
 * Reads from package.json so there is only one place to update.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

export const VERSION: string = pkg.version;
