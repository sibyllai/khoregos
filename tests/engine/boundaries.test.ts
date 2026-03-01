/**
 * Tests for BoundaryEnforcer: pattern matching, path checks, violations.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { BoundaryEnforcer, revertFile } from "../../src/engine/boundaries.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import type { BoundaryConfig } from "../../src/models/config.js";

describe("BoundaryEnforcer", () => {
  let db: Db;
  const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const projectRoot = "/tmp/k6s-boundary-test";

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  describe("getBoundaryForAgent", () => {
    it("returns boundary when agent name matches pattern", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "primary", allowed_paths: [], forbidden_paths: [], enforcement: "advisory" },
        { pattern: "*", allowed_paths: ["*"], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const b = enforcer.getBoundaryForAgent("primary");
      expect(b).not.toBeNull();
      expect(b!.pattern).toBe("primary");
    });

    it("returns wildcard boundary when no specific match", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "primary", allowed_paths: [], forbidden_paths: [], enforcement: "advisory" },
        { pattern: "*", allowed_paths: ["src/**"], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const b = enforcer.getBoundaryForAgent("other-agent");
      expect(b).not.toBeNull();
      expect(b!.pattern).toBe("*");
    });

    it("returns null when no boundary matches", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "primary", allowed_paths: [], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const b = enforcer.getBoundaryForAgent("other-agent");
      expect(b).toBeNull();
    });
  });

  describe("checkPathAllowed", () => {
    it("denies when no boundary for agent", () => {
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, []);
      const [allowed, reason] = enforcer.checkPathAllowed("src/foo.ts", "x");
      expect(allowed).toBe(false);
      expect(reason).toContain("No boundary configured");
    });

    it("allows path that matches allowed_paths", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "*", allowed_paths: ["src/**", "*.json"], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const [allowed] = enforcer.checkPathAllowed("src/foo.ts", "primary");
      expect(allowed).toBe(true);
    });

    it("denies path that matches forbidden_paths", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "*", allowed_paths: ["**"], forbidden_paths: [".env*", "**/*.pem"], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const [allowed, reason] = enforcer.checkPathAllowed(".env.local", "primary");
      expect(allowed).toBe(false);
      expect(reason).toContain("forbidden");
    });

    it("denies path outside project root", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "*", allowed_paths: ["**"], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const [allowed, reason] = enforcer.checkPathAllowed("/etc/passwd", "primary");
      expect(allowed).toBe(false);
      expect(reason).toContain("outside project root");
    });
  });

  describe("recordViolation and getViolations", () => {
    it("records violation and returns it", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "*", allowed_paths: [], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const v = enforcer.recordViolation({
        filePath: "/tmp/out",
        agentId: "agent-1",
        violationType: "forbidden_path",
        enforcementAction: "logged",
        details: { pattern: ".env" },
      });
      expect(v.id).toBeDefined();
      expect(v.sessionId).toBe(sessionId);
      expect(v.filePath).toBe("/tmp/out");
      expect(v.violationType).toBe("forbidden_path");
    });

    it("getViolations returns recorded violations", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "*", allowed_paths: [], forbidden_paths: [], enforcement: "advisory" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const list = enforcer.getViolations(undefined, 10);
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe("getAgentBoundariesSummary", () => {
    it("returns has_boundary false when no boundary", () => {
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, []);
      const summary = enforcer.getAgentBoundariesSummary("x");
      expect(summary.has_boundary).toBe(false);
      expect(summary.enforcement).toBe("deny");
    });

    it("returns has_boundary true with paths when boundary exists", () => {
      const boundaries: BoundaryConfig[] = [
        { pattern: "primary", allowed_paths: ["src/**"], forbidden_paths: [".env*"], enforcement: "strict" },
      ];
      const enforcer = new BoundaryEnforcer(db, sessionId, projectRoot, boundaries);
      const summary = enforcer.getAgentBoundariesSummary("primary");
      expect(summary.has_boundary).toBe(true);
      expect(summary.allowed_paths).toEqual(["src/**"]);
      expect(summary.forbidden_paths).toEqual([".env*"]);
      expect(summary.enforcement).toBe("strict");
    });
  });

  describe("revertFile", () => {
    it("reverts tracked file content to the last commit", () => {
      const repoRoot = mkdtempSync(path.join(tmpdir(), "k6s-boundary-revert-"));
      try {
        execFileSync("git", ["init"], { cwd: repoRoot, stdio: "pipe" });
        const filePath = path.join(repoRoot, "tracked.txt");
        writeFileSync(filePath, "safe content\n", "utf-8");
        execFileSync("git", ["add", "tracked.txt"], { cwd: repoRoot, stdio: "pipe" });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=K6s Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "test commit",
          ],
          { cwd: repoRoot, stdio: "pipe" },
        );

        writeFileSync(filePath, "violating content\n", "utf-8");

        const original = revertFile(filePath, repoRoot);

        expect(original).toContain("violating content");
        expect(readFileSync(filePath, "utf-8")).toBe("safe content\n");
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("removes untracked files when strict revert runs", () => {
      const repoRoot = mkdtempSync(path.join(tmpdir(), "k6s-boundary-revert-"));
      try {
        execFileSync("git", ["init"], { cwd: repoRoot, stdio: "pipe" });
        const filePath = path.join(repoRoot, "untracked.txt");
        writeFileSync(filePath, "new violating file\n", "utf-8");

        const original = revertFile(filePath, repoRoot);

        expect(original).toContain("new violating file");
        expect(existsSync(filePath)).toBe(false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});
