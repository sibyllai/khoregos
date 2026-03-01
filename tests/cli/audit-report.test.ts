/**
 * CLI tests for audit report command wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const generateAuditReportMock = vi.fn(() => "# Khoregos audit report\n");
const withDbMock = vi.fn((_projectRoot: string, fn: (db: object) => unknown) => fn({}));
const resolveSessionIdMock = vi.fn(() => "session-123");

vi.mock("../../src/engine/report.js", () => ({
  generateAuditReport: (...args: unknown[]) => generateAuditReportMock(...args),
}));

vi.mock("../../src/cli/shared.js", () => ({
  withDb: (...args: unknown[]) => withDbMock(...args),
  resolveSessionId: (...args: unknown[]) => resolveSessionIdMock(...args),
}));

describe("audit report command", () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    generateAuditReportMock.mockClear();
    withDbMock.mockClear();
    resolveSessionIdMock.mockClear();

    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-audit-report-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".khoregos", "k6s.db"), "");
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("prints markdown report to stdout when output is omitted", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(["audit", "report", "--session", "latest"], { from: "user" });

    expect(withDbMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionIdMock).toHaveBeenCalledTimes(1);
    expect(generateAuditReportMock).toHaveBeenCalledWith({}, "session-123", process.cwd());
    expect(logSpy).toHaveBeenCalledWith("# Khoregos audit report\n");
  });

  it("writes markdown report to output file when requested", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    const outputPath = path.join(projectRoot, "report.md");
    await program.parseAsync(
      ["audit", "report", "--session", "latest", "--output", outputPath],
      { from: "user" },
    );

    const fileContents = readFileSync(outputPath, "utf-8");
    expect(fileContents).toBe("# Khoregos audit report\n");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Wrote audit report to"));
  });
});
