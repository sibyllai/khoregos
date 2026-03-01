/**
 * Integration-style test for strict post-tool-use hook enforcement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const setWebhookDispatcherMock = vi.fn();
const auditLogMock = vi.fn(() => ({ id: "evt-tool-use" }));
const recordViolationMock = vi.fn();
const revertFileMock = vi.fn(() => "SECRET=violating\n");
let currentBoundaryEnforcement: "advisory" | "strict" = "strict";
const loadConfigOrDefaultMock = vi.fn(() => ({
  boundaries: [
    {
      pattern: "primary",
      allowed_paths: ["src/**"],
      forbidden_paths: [".env*"],
      enforcement: "strict",
    },
  ],
  gates: [],
  observability: { webhooks: [] },
}));
const classifySeverityMock = vi.fn(() => "warning");
const extractPathsFromBashCommandMock = vi.fn((): string[] => []);
const readHookPayloadChunks: Buffer[] = [];
const readSyncMock = vi.fn(
  (
    _fd: number,
    buffer: Buffer,
    _offset: number,
    _length: number,
    _position: number | null,
  ): number => {
    const chunk = readHookPayloadChunks.shift();
    if (!chunk) return 0;
    chunk.copy(buffer, 0);
    return chunk.length;
  },
);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => readSyncMock(...args),
  };
});

vi.mock("../../src/daemon/manager.js", () => {
  class MockDaemonState {
    constructor(private _khoregoDir: string) {}
    isRunning(): boolean {
      return true;
    }
    readState(): Record<string, unknown> {
      return { session_id: "session-1" };
    }
  }
  return { DaemonState: MockDaemonState };
});

vi.mock("../../src/models/config.js", () => ({
  loadConfigOrDefault: (...args: unknown[]) => loadConfigOrDefaultMock(...args),
}));

vi.mock("../../src/engine/signing.js", () => ({
  loadSigningKey: vi.fn(() => Buffer.alloc(32, 1)),
}));

vi.mock("../../src/engine/audit.js", () => ({
  AuditLogger: class {
    start(): void {}
    stop(): void {}
    log(...args: unknown[]): { id: string } {
      return auditLogMock(...args);
    }
  },
  setWebhookDispatcher: (...args: unknown[]) => setWebhookDispatcherMock(...args),
}));

vi.mock("../../src/engine/boundaries.js", () => ({
  BoundaryEnforcer: class {
    constructor(
      private _db: unknown,
      private _sessionId: string,
      private _projectRoot: string,
      private _boundaries: unknown[],
    ) {}
    getBoundaryForAgent(): Record<string, unknown> {
      return { enforcement: currentBoundaryEnforcement };
    }
    checkPathAllowed(): [boolean, string] {
      return [false, "Path matches forbidden pattern: .env*"];
    }
    recordViolation(...args: unknown[]): void {
      recordViolationMock(...args);
    }
  },
  revertFile: (...args: unknown[]) => revertFileMock(...args),
}));

vi.mock("../../src/store/db.js", () => ({
  Db: class {
    connect(): void {}
    close(): void {}
  },
}));

vi.mock("../../src/engine/state.js", () => ({
  StateManager: class {
    constructor(_db: unknown, _projectRoot: string) {}
    getSession(_sessionId: string): { traceId: string } {
      return { traceId: "trace-1" };
    }
    getAgentByClaudeSessionId(
      _sessionId: string,
      _claudeSessionId: string,
    ): { id: string } | null {
      return { id: "agent-1" };
    }
    assignClaudeSessionToNewestUnassignedAgent(): null {
      return null;
    }
    getAgent(_agentId: string): { name: string } | null {
      return { name: "primary" };
    }
    getAgentByName(): null {
      return null;
    }
    registerAgent(): { id: string } {
      return { id: "agent-1" };
    }
    incrementToolCallCount(): number {
      return 1;
    }
  },
}));

vi.mock("../../src/engine/severity.js", () => ({
  classifySeverity: (...args: unknown[]) => classifySeverityMock(...args),
  extractPathsFromBashCommand: (...args: unknown[]) => extractPathsFromBashCommandMock(...args),
}));

vi.mock("../../src/engine/telemetry.js", () => ({
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
  getTracer: () => ({
    startActiveSpan: (
      _name: string,
      _opts: unknown,
      fn: (span: { end: () => void }) => void,
    ) => fn({ end: () => {} }),
  }),
  recordActiveAgentDelta: vi.fn(),
  recordToolDurationSeconds: vi.fn(),
}));

describe("hook post-tool-use strict enforcement", () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-hook-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, "k6s.yaml"), "version: '1'\n", "utf-8");
    process.chdir(projectRoot);
    vi.clearAllMocks();
    currentBoundaryEnforcement = "strict";
    readHookPayloadChunks.length = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("reverts forbidden writes and logs critical boundary_violation event", async () => {
    const hookPayload = JSON.stringify({
      tool_name: "Write",
      tool_input: { path: ".env.local" },
      session_id: "claude-session-1",
      tool_use_id: "tool-use-1",
      tool_response: "ok",
    });
    readHookPayloadChunks.push(Buffer.from(hookPayload, "utf-8"));

    const { registerHookCommands } = await import("../../src/cli/hook.js");
    const program = new Command();
    registerHookCommands(program);

    await program.parseAsync(["hook", "post-tool-use"], { from: "user" });

    expect(revertFileMock).toHaveBeenCalledTimes(1);
    expect(recordViolationMock).toHaveBeenCalledTimes(1);
    expect(recordViolationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: ".env.local",
        agentId: "agent-1",
        violationType: "forbidden_path",
        enforcementAction: "reverted",
      }),
    );
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "boundary_violation",
        severity: "critical",
        details: expect.objectContaining({
          enforcement_action: "reverted",
          file: ".env.local",
        }),
      }),
    );
    expect(setWebhookDispatcherMock).toHaveBeenCalled();
  });

  it("does not revert writes when boundary enforcement is advisory", async () => {
    currentBoundaryEnforcement = "advisory";
    const hookPayload = JSON.stringify({
      tool_name: "Write",
      tool_input: { path: ".env.local" },
      session_id: "claude-session-1",
      tool_use_id: "tool-use-2",
      tool_response: "ok",
    });
    readHookPayloadChunks.push(Buffer.from(hookPayload, "utf-8"));

    const { registerHookCommands } = await import("../../src/cli/hook.js");
    const program = new Command();
    registerHookCommands(program);

    await program.parseAsync(["hook", "post-tool-use"], { from: "user" });

    expect(revertFileMock).not.toHaveBeenCalled();
    expect(recordViolationMock).not.toHaveBeenCalled();
    const hasBoundaryViolationAudit = auditLogMock.mock.calls.some((call) => {
      const [payload] = call as [{ eventType?: string }];
      return payload?.eventType === "boundary_violation";
    });
    expect(hasBoundaryViolationAudit).toBe(false);
  });
});
