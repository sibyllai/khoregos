/**
 * Tests for telemetry daemon lifecycle helpers in team CLI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

describe("team telemetry daemon helpers", () => {
  let projectRoot: string;
  let pidPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-team-telemetry-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    pidPath = path.join(projectRoot, ".khoregos", "telemetry.pid");
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("startTelemetryDaemon spawns detached telemetry serve and writes pid file", async () => {
    const spawnMock = vi.mocked(spawn);
    const unref = vi.fn();
    spawnMock.mockReturnValue({
      pid: 4242,
      unref,
    } as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const team = await import("../../src/cli/team.js");

    team.startTelemetryDaemon(projectRoot);

    expect(spawnMock).toHaveBeenCalledWith(
      "k6s",
      ["telemetry", "serve", "--project-root", projectRoot],
      { detached: true, stdio: "ignore" },
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
    expect(readFileSync(pidPath, "utf-8").trim()).toBe("4242");
  });

  it("startTelemetryDaemon stops previous daemon before spawning new one", async () => {
    writeFileSync(pidPath, "5151\n", "utf-8");
    const spawnMock = vi.mocked(spawn);
    const unref = vi.fn();
    spawnMock.mockReturnValue({
      pid: 6161,
      unref,
    } as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const team = await import("../../src/cli/team.js");

    team.startTelemetryDaemon(projectRoot);

    expect(killSpy).toHaveBeenCalledWith(5151, "SIGTERM");
    expect(readFileSync(pidPath, "utf-8").trim()).toBe("6161");
  });

  it("stopTelemetryDaemon clears pid file when process is already gone", async () => {
    writeFileSync(pidPath, "7777\n", "utf-8");
    const err = Object.assign(new Error("No such process."), { code: "ESRCH" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    const team = await import("../../src/cli/team.js");

    team.stopTelemetryDaemon(projectRoot);

    expect(existsSync(pidPath)).toBe(false);
  });
});
