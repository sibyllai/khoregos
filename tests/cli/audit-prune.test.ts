/**
 * CLI tests for audit prune command wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const withDbMock = vi.fn((_projectRoot: string, fn: (db: object) => unknown) => fn({}));
const pruneAuditEventsMock = vi.fn(() => ({ eventsDeleted: 0, sessionsPruned: 0 }));
const pruneSessionsMock = vi.fn(() => ({ sessionsPruned: 0 }));
const loadConfigOrDefaultMock = vi.fn(() => ({
  session: { audit_retention_days: 365, session_retention_days: 365 },
}));

vi.mock("../../src/cli/shared.js", () => ({
  withDb: (...args: unknown[]) => withDbMock(...args),
  resolveSessionId: vi.fn(),
}));

vi.mock("../../src/engine/audit.js", () => ({
  AuditLogger: class {},
  pruneAuditEvents: (...args: unknown[]) => pruneAuditEventsMock(...args),
  pruneSessions: (...args: unknown[]) => pruneSessionsMock(...args),
}));

vi.mock("../../src/models/config.js", () => ({
  loadConfigOrDefault: (...args: unknown[]) => loadConfigOrDefaultMock(...args),
}));

describe("audit prune command", () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    withDbMock.mockClear();
    pruneAuditEventsMock.mockClear();
    pruneSessionsMock.mockClear();
    loadConfigOrDefaultMock.mockClear();

    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-audit-prune-cli-"));
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

  it("with no explicit dates prunes both events and sessions from retention settings", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(["audit", "prune"], { from: "user" });

    expect(pruneAuditEventsMock).toHaveBeenCalledTimes(1);
    expect(pruneSessionsMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pruned 0 events, 0 sessions"));
  });

  it("with --before only prunes audit events", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(
      ["audit", "prune", "--before", "2025-01-01T00:00:00.000Z"],
      { from: "user" },
    );

    expect(pruneAuditEventsMock).toHaveBeenCalledTimes(1);
    expect(pruneSessionsMock).toHaveBeenCalledTimes(0);
  });

  it("with --sessions-before only prunes sessions", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(
      ["audit", "prune", "--sessions-before", "2025-01-01T00:00:00.000Z"],
      { from: "user" },
    );

    expect(pruneAuditEventsMock).toHaveBeenCalledTimes(0);
    expect(pruneSessionsMock).toHaveBeenCalledTimes(1);
  });
});
