/**
 * Tests for the .claude/settings.json self-repair on native module
 * ABI mismatch. When hooks fire from a stale nvm path (e.g. v21) under
 * a newer running Node (e.g. v22), the self-repair rewrites the
 * version segment in settings.json so the next hook invocation uses
 * the correct path.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Command } from "commander";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("hook self-repair (.claude/settings.json)", () => {
  let exitMock: ReturnType<typeof vi.spyOn>;
  let stderrMock: ReturnType<typeof vi.spyOn>;
  let exitCalls: (string | number | null | undefined)[];
  let stderrOutput: string[];
  let originalCwd: string;
  let originalArgv1: string;
  let workdir: string;
  let settingsPath: string;
  let fakeOldVer: string;
  let fakeNewVer: string;
  let fakeOldScriptPath: string;
  let fakeNewScriptPath: string;

  beforeEach(() => {
    exitCalls = [];
    stderrOutput = [];
    exitMock = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined,
    ) => {
      exitCalls.push(code);
      throw new Error(`__exit_${code}__`);
    }) as never);
    stderrMock = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrOutput.push(String(chunk));
        return true;
      });

    originalCwd = process.cwd();
    originalArgv1 = process.argv[1];

    workdir = mkdtempSync(path.join(tmpdir(), "k6s-self-repair-"));
    mkdirSync(path.join(workdir, ".claude"), { recursive: true });

    // Use a different version than the running Node so the regex triggers.
    fakeOldVer = "v21.7.1";
    fakeNewVer = `v${process.versions.node}`;
    if (fakeOldVer === fakeNewVer) {
      fakeOldVer = "v18.0.0"; // ensure they differ
    }

    // Create a fake "current" k6s.js script under a synthetic nvm-like
    // directory inside the workdir. The new path must EXIST for the
    // self-repair to proceed.
    const newDir = path.join(workdir, "versions", "node", fakeNewVer, "lib", "node_modules", "@sibyllai", "khoregos", "bin");
    mkdirSync(newDir, { recursive: true });
    fakeNewScriptPath = path.join(newDir, "k6s.js");
    writeFileSync(fakeNewScriptPath, "// fake k6s\n");

    // The "old" (broken) script path mirrors the structure with the old version.
    fakeOldScriptPath = path.join(
      workdir,
      "versions",
      "node",
      fakeOldVer,
      "lib",
      "node_modules",
      "@sibyllai",
      "khoregos",
      "bin",
      "k6s.js",
    );

    // Settings file referencing the OLD path in hook commands.
    settingsPath = path.join(workdir, ".claude", "settings.json");
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `"${fakeOldScriptPath}" hook post-tool-use`,
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `"${fakeOldScriptPath}" hook session-stop`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
      mode: 0o600,
    });

    // Point process.cwd at workdir and process.argv[1] at the broken path.
    process.chdir(workdir);
    process.argv[1] = fakeOldScriptPath;
  });

  afterEach(() => {
    exitMock.mockRestore();
    stderrMock.mockRestore();
    process.chdir(originalCwd);
    process.argv[1] = originalArgv1;
    rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rewrites settings.json version segment when ABI mismatch is detected", async () => {
    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    // Find the latest uncaughtException handler we just registered.
    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    expect(handler).toBeDefined();

    const dlopenErr = new Error(
      "The module '/foo.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 120",
    ) as NodeJS.ErrnoException;
    dlopenErr.code = "ERR_DLOPEN_FAILED";

    expect(() => handler!(dlopenErr)).toThrow("__exit_0__");
    expect(exitCalls).toContain(0);

    // The repair message should appear in stderr.
    const stderr = stderrOutput.join("");
    expect(stderr).toContain("Self-repair");
    expect(stderr).toContain(fakeOldVer);
    expect(stderr).toContain(fakeNewVer);

    // The settings file should now reference the new version.
    const updated = readFileSync(settingsPath, "utf-8");
    expect(updated).toContain(`/versions/node/${fakeNewVer}/`);
    expect(updated).not.toContain(`/versions/node/${fakeOldVer}/`);
  });

  it("does not rewrite when the new path does not exist", async () => {
    // Remove the new script so existsSync returns false.
    rmSync(fakeNewScriptPath);

    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    const dlopenErr = new Error(
      "was compiled against a different Node.js version",
    ) as NodeJS.ErrnoException;
    dlopenErr.code = "ERR_DLOPEN_FAILED";

    expect(() => handler!(dlopenErr)).toThrow("__exit_0__");

    const stderr = stderrOutput.join("");
    expect(stderr).not.toContain("Self-repair");

    // Settings file unchanged.
    const updated = readFileSync(settingsPath, "utf-8");
    expect(updated).toContain(`/versions/node/${fakeOldVer}/`);
  });

  it("does not rewrite when the broken path is not nvm-style", async () => {
    process.argv[1] = "/usr/local/bin/k6s.js";

    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    const dlopenErr = new Error(
      "was compiled against a different Node.js version",
    ) as NodeJS.ErrnoException;
    dlopenErr.code = "ERR_DLOPEN_FAILED";

    expect(() => handler!(dlopenErr)).toThrow("__exit_0__");

    const stderr = stderrOutput.join("");
    expect(stderr).not.toContain("Self-repair");

    const updated = readFileSync(settingsPath, "utf-8");
    expect(updated).toContain(`/versions/node/${fakeOldVer}/`);
  });

  it("does not rewrite when no .claude/settings.json exists", async () => {
    rmSync(settingsPath);

    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    const dlopenErr = new Error(
      "was compiled against a different Node.js version",
    ) as NodeJS.ErrnoException;
    dlopenErr.code = "ERR_DLOPEN_FAILED";

    expect(() => handler!(dlopenErr)).toThrow("__exit_0__");

    const stderr = stderrOutput.join("");
    expect(stderr).not.toContain("Self-repair");
  });
});
