/**
 * Test helpers: temp DB path, cleanup.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

let tempRoot: string | null = null;

/**
 * Create a unique temp directory for test artifacts (e.g. SQLite DB).
 * Call cleanupTempDir() in afterAll to remove it.
 */
export function createTempDir(): string {
  tempRoot = mkdtempSync(path.join(tmpdir(), "k6s-test-"));
  return tempRoot;
}

/**
 * Get a unique DB path inside the current temp dir (or create one).
 */
export function getTempDbPath(): string {
  if (!tempRoot) {
    tempRoot = mkdtempSync(path.join(tmpdir(), "k6s-test-"));
  }
  return path.join(tempRoot, `db-${randomBytes(4).toString("hex")}.db`);
}

/**
 * Remove the temp directory created by createTempDir / getTempDbPath.
 */
export function cleanupTempDir(): void {
  if (tempRoot) {
    try {
      rmSync(tempRoot, { recursive: true });
    } finally {
      tempRoot = null;
    }
  }
}
