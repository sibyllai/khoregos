/**
 * Integration-style CLI tests for team start/stop command wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const registerMcpServerMock = vi.fn();
const registerHooksMock = vi.fn();
const unregisterMcpServerMock = vi.fn();
const unregisterHooksMock = vi.fn();
const isPluginInstalledMock = vi.fn(() => false);
const injectClaudeMdGovernanceMock = vi.fn();
const removeClaudeMdGovernanceMock = vi.fn();
const auditLoggerStartMock = vi.fn();
const auditLoggerLogMock = vi.fn();
const auditLoggerStopMock = vi.fn();
const pruneAuditEventsMock = vi.fn();
const pruneSessionsMock = vi.fn();
const loadConfigMock = vi.fn(() => ({
  version: "1",
  project: { name: "test" },
  session: { context_retention_days: 90, audit_retention_days: 365, session_retention_days: 365 },
  boundaries: [],
  gates: [],
  observability: {
    prometheus: { enabled: true, port: 9090 },
    opentelemetry: { enabled: false, endpoint: "http://localhost:4318" },
    webhooks: [],
  },
  plugins: [],
}));

type DaemonRecord = { session_id?: string };
const daemonStateByDir = new Map<string, DaemonRecord>();

vi.mock("../../src/daemon/manager.js", () => {
  class MockDaemonState {
    constructor(private khoregoDir: string) {}

    isRunning(): boolean {
      return daemonStateByDir.has(this.khoregoDir);
    }

    readState(): Record<string, unknown> {
      return daemonStateByDir.get(this.khoregoDir) ?? {};
    }

    createState(state: Record<string, unknown>): boolean {
      if (daemonStateByDir.has(this.khoregoDir)) return false;
      daemonStateByDir.set(this.khoregoDir, { session_id: state.session_id as string });
      return true;
    }

    removeState(): void {
      daemonStateByDir.delete(this.khoregoDir);
    }
  }

  return {
    DaemonState: MockDaemonState,
    registerMcpServer: registerMcpServerMock,
    registerHooks: registerHooksMock,
    unregisterMcpServer: unregisterMcpServerMock,
    unregisterHooks: unregisterHooksMock,
    isPluginInstalled: (...args: unknown[]) => isPluginInstalledMock(...args),
    injectClaudeMdGovernance: injectClaudeMdGovernanceMock,
    removeClaudeMdGovernance: removeClaudeMdGovernanceMock,
  };
});

vi.mock("../../src/models/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  sanitizeConfigForStorage: vi.fn((cfg) => cfg),
  detectHardcodedSecrets: vi.fn(() => []),
}));

vi.mock("../../src/engine/signing.js", () => ({
  loadSigningKey: vi.fn(() => Buffer.alloc(32, 7)),
}));

vi.mock("../../src/engine/audit.js", () => ({
  AuditLogger: class {
    start(): void {
      auditLoggerStartMock();
    }
    log(event: unknown): void {
      auditLoggerLogMock(event);
    }
    stop(): void {
      auditLoggerStopMock();
    }
  },
  pruneAuditEvents: (...args: unknown[]) => pruneAuditEventsMock(...args),
  pruneSessions: (...args: unknown[]) => pruneSessionsMock(...args),
  setWebhookDispatcher: vi.fn(),
}));

vi.mock("../../src/store/db.js", () => ({
  Db: class {
    connect(): void {}
    close(): void {}
    fetchOne(): Record<string, unknown> | null { return { total: 0 }; }
  },
}));

let sessionCounter = 0;
vi.mock("../../src/engine/state.js", () => ({
  StateManager: class {
    createSession(args: { objective: string }) {
      sessionCounter += 1;
      return {
        id: `session-${sessionCounter}`,
        objective: args.objective,
        traceId: `trace-${sessionCounter}`,
        operator: null,
        hostname: null,
        k6sVersion: null,
        claudeCodeVersion: null,
        gitBranch: null,
        gitSha: null,
        gitDirty: false,
      };
    }
    updateSession(): void {}
    markSessionActive(): void {}
    markSessionCompleted(): void {}
    getSession(sessionId: string) {
      return {
        id: sessionId,
        objective: "resume objective",
        operator: "test-operator",
      };
    }
    listSessions() {
      return [
        {
          id: "prev-session",
          objective: "latest resume objective",
          operator: "test-operator",
        },
      ];
    }
    generateResumeContext(): string {
      return "resume context";
    }
    saveContext(): void {}
  },
}));

vi.mock("../../src/engine/langfuse.js", () => ({
  initLangfuse: vi.fn(),
  shutdownLangfuse: vi.fn(async () => {}),
  createSessionTrace: vi.fn(() => null),
  updateSessionTrace: vi.fn(),
  scoreSession: vi.fn(),
}));

vi.mock("../../src/engine/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: { end: () => void }) => void) =>
      fn({ end: () => {} }),
  }),
  redactEndpointForLogs: (s: string) => s,
  recordSessionStart: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

const spawnMock = vi.fn(() => ({
  pid: 13579,
  unref: vi.fn(),
}));
const execFileSyncMock = vi.fn(() => {
  throw new Error("mocked no git/claude");
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

describe("team commands integration", () => {
  let projectRoot: string;
  let originalCwd: string;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-team-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, "k6s.yaml"), "version: '1'\nproject:\n  name: test\n", "utf-8");
    process.chdir(projectRoot);

    daemonStateByDir.clear();
    sessionCounter = 0;
    spawnMock.mockClear();
    execFileSyncMock.mockClear();
    registerMcpServerMock.mockClear();
    registerHooksMock.mockClear();
    unregisterHooksMock.mockClear();
    unregisterMcpServerMock.mockClear();
    isPluginInstalledMock.mockClear();
    isPluginInstalledMock.mockReturnValue(false);
    injectClaudeMdGovernanceMock.mockClear();
    removeClaudeMdGovernanceMock.mockClear();
    loadConfigMock.mockClear();
    auditLoggerStartMock.mockClear();
    auditLoggerLogMock.mockClear();
    auditLoggerStopMock.mockClear();
    pruneAuditEventsMock.mockClear();
    pruneSessionsMock.mockClear();
    pruneAuditEventsMock.mockReturnValue({ eventsDeleted: 0, sessionsPruned: 0 });
    pruneSessionsMock.mockReturnValue({ sessionsPruned: 0 });
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    killSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("team start then team stop manages telemetry daemon pid lifecycle", async () => {
    const { registerTeamCommands, telemetryPidFile } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "start", "integration objective"], { from: "user" });

    expect(registerMcpServerMock).toHaveBeenCalledTimes(1);
    expect(registerHooksMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe("k6s");
    expect(args[0]).toBe("telemetry");
    expect(args[1]).toBe("serve");
    expect(args[2]).toBe("--project-root");
    expect(args[3]).toContain(path.basename(projectRoot));
    expect(options).toEqual({ detached: true, stdio: "ignore" });

    const pidPath = telemetryPidFile(projectRoot);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8").trim()).toBe("13579");

    await program.parseAsync(["team", "stop"], { from: "user" });

    expect(removeClaudeMdGovernanceMock).toHaveBeenCalledTimes(1);
    expect(unregisterHooksMock).toHaveBeenCalledTimes(1);
    expect(unregisterMcpServerMock).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(13579, "SIGTERM");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("team start and stop skip registration cleanup when plugin is installed", async () => {
    isPluginInstalledMock.mockReturnValue(true);
    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "start", "plugin objective"], { from: "user" });
    await program.parseAsync(["team", "stop"], { from: "user" });

    expect(registerMcpServerMock).not.toHaveBeenCalled();
    expect(registerHooksMock).not.toHaveBeenCalled();
    expect(unregisterHooksMock).not.toHaveBeenCalled();
    expect(unregisterMcpServerMock).not.toHaveBeenCalled();
    expect(injectClaudeMdGovernanceMock).toHaveBeenCalledTimes(1);
    expect(removeClaudeMdGovernanceMock).toHaveBeenCalledTimes(1);
  });

  it("team start fails when strict enforcement is configured outside git", async () => {
    loadConfigMock.mockReturnValueOnce({
      version: "1",
      project: { name: "test" },
      session: { context_retention_days: 90, audit_retention_days: 365, session_retention_days: 365 },
      boundaries: [
        {
          pattern: "*",
          allowed_paths: ["**"],
          forbidden_paths: [".env*"],
          enforcement: "strict",
        },
      ],
      gates: [],
      observability: {
        prometheus: { enabled: false, port: 9090 },
        opentelemetry: { enabled: false, endpoint: "http://localhost:4318" },
        webhooks: [],
      },
      plugins: [],
    });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await expect(
      program.parseAsync(["team", "start", "strict objective"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("strict boundary enforcement requires a git repository."),
    );
    expect(registerMcpServerMock).not.toHaveBeenCalled();
    expect(registerHooksMock).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("team start logs session_start action with objective and truncates long text", async () => {
    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    const longObjective = `${"x".repeat(210)}\n${"y".repeat(20)}`;
    await program.parseAsync(["team", "start", longObjective], { from: "user" });

    const loggedEvent = auditLoggerLogMock.mock.calls[0]?.[0] as
      | { eventType?: string; action?: string; details?: { objective?: string } }
      | undefined;
    expect(loggedEvent?.eventType).toBe("session_start");
    expect(loggedEvent?.action).toBe(`session started: ${"x".repeat(197)}...`);
    expect(loggedEvent?.details?.objective).toBe(longObjective);
  });

  it("team start logs an auto-prune system event when records are deleted", async () => {
    pruneAuditEventsMock.mockReturnValueOnce({ eventsDeleted: 7, sessionsPruned: 0 });
    pruneSessionsMock.mockReturnValueOnce({ sessionsPruned: 2 });

    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "start", "auto prune objective"], { from: "user" });

    const events = auditLoggerLogMock.mock.calls.map((call) => call[0] as {
      eventType?: string;
      action?: string;
      details?: Record<string, unknown>;
    });
    const systemEvent = events.find((event) => event.eventType === "system");
    expect(systemEvent?.action).toBe("auto-prune: 7 events, 2 sessions");
    expect(systemEvent?.details).toMatchObject({
      audit_retention_days: 365,
      session_retention_days: 365,
      events_deleted: 7,
      sessions_pruned: 2,
    });
  });

  it("team resume logs session_start action with resumed objective", async () => {
    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "resume", "previous-session"], { from: "user" });

    const loggedEvent = auditLoggerLogMock.mock.calls[0]?.[0] as
      | { eventType?: string; action?: string; details?: { objective?: string; resumed_from_session_id?: string } }
      | undefined;
    expect(loggedEvent?.eventType).toBe("session_start");
    expect(loggedEvent?.action).toBe("session started: resume objective");
    expect(loggedEvent?.details?.objective).toBe("resume objective");
    expect(loggedEvent?.details?.resumed_from_session_id).toBe("previous-session");
  });

  it("team resume latest resolves to the newest session", async () => {
    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "resume", "latest"], { from: "user" });

    const loggedEvent = auditLoggerLogMock.mock.calls[0]?.[0] as
      | { eventType?: string; action?: string; details?: { objective?: string; resumed_from_session_id?: string } }
      | undefined;
    expect(loggedEvent?.eventType).toBe("session_start");
    expect(loggedEvent?.action).toBe("session started: latest resume objective");
    expect(loggedEvent?.details?.objective).toBe("latest resume objective");
    expect(loggedEvent?.details?.resumed_from_session_id).toBe("prev-session");
  });
});
