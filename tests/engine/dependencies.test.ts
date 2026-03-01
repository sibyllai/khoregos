/**
 * Tests for dependency diff detection from package.json changes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectDependencyChanges, diffDeps } from "../../src/engine/dependencies.js";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function commitAll(cwd: string, message: string): void {
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message]);
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

describe("diffDeps", () => {
  it("returns added, removed, and updated entries", () => {
    const changes = diffDeps(
      { alpha: "^1.0.0", beta: "^1.0.0", gamma: "^1.0.0" },
      { alpha: "^1.0.1", gamma: "^1.0.0", delta: "^2.0.0" },
    );

    expect(changes).toEqual([
      { type: "updated", name: "alpha", oldVersion: "^1.0.0", newVersion: "^1.0.1" },
      { type: "added", name: "delta", newVersion: "^2.0.0" },
      { type: "removed", name: "beta", oldVersion: "^1.0.0" },
    ]);
  });
});

describe("detectDependencyChanges", () => {
  let rootDir = "";

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "k6s-deps-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns empty changes for non-package.json files", () => {
    const filePath = path.join(rootDir, "other.json");
    writeJson(filePath, { dependencies: { lodash: "^4.17.21" } });

    const changes = detectDependencyChanges(filePath, rootDir);
    expect(changes).toEqual([]);
  });

  it("detects added, removed, and updated dependencies in a git repo", () => {
    runGit(rootDir, ["init"]);
    const packagePath = path.join(rootDir, "package.json");
    writeJson(packagePath, {
      dependencies: { lodash: "^4.17.20", chalk: "^5.0.0" },
      devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
    });
    commitAll(rootDir, "baseline package");

    writeJson(packagePath, {
      dependencies: { lodash: "^4.17.21", zod: "^3.24.2" },
      devDependencies: { typescript: "^5.0.0", vitest: "^3.0.5" },
    });

    const changes = detectDependencyChanges(packagePath, rootDir);
    expect(changes).toEqual(
      expect.arrayContaining([
        {
          type: "updated",
          name: "lodash",
          oldVersion: "^4.17.20",
          newVersion: "^4.17.21",
        },
        {
          type: "removed",
          name: "chalk",
          oldVersion: "^5.0.0",
        },
        {
          type: "added",
          name: "zod",
          newVersion: "^3.24.2",
        },
        {
          type: "updated",
          name: "vitest",
          oldVersion: "^1.0.0",
          newVersion: "^3.0.5",
        },
      ]),
    );
  });

  it("treats all current dependencies as added for a new package.json in git", () => {
    runGit(rootDir, ["init"]);
    writeFileSync(path.join(rootDir, "README.md"), "# temp repo\n", "utf-8");
    commitAll(rootDir, "initial commit");

    const packagePath = path.join(rootDir, "package.json");
    writeJson(packagePath, {
      dependencies: { axios: "^1.8.0" },
      devDependencies: { vitest: "^3.0.5" },
    });

    const changes = detectDependencyChanges(packagePath, rootDir);
    expect(changes).toEqual(
      expect.arrayContaining([
        { type: "added", name: "axios", newVersion: "^1.8.0" },
        { type: "added", name: "vitest", newVersion: "^3.0.5" },
      ]),
    );
  });

  it("returns no changes in a non-git directory", () => {
    const packagePath = path.join(rootDir, "package.json");
    writeJson(packagePath, {
      dependencies: { axios: "^1.8.0" },
    });

    const changes = detectDependencyChanges(packagePath, rootDir);
    expect(changes).toEqual([]);
  });

  it("returns no changes when package.json is malformed", () => {
    runGit(rootDir, ["init"]);
    const packagePath = path.join(rootDir, "package.json");
    writeJson(packagePath, { dependencies: { lodash: "^4.17.21" } });
    commitAll(rootDir, "baseline package");

    mkdirSync(path.join(rootDir, "tmp"), { recursive: true });
    writeFileSync(packagePath, "{ invalid-json", "utf-8");

    const changes = detectDependencyChanges(packagePath, rootDir);
    expect(changes).toEqual([]);
  });
});
