/**
 * Tests for the safeHookAction wrapper that catches hook failures and
 * exits non-blocking so Claude Code never sees a "Stop hook error".
 *
 * The most common failure mode is a native module ABI mismatch
 * (better-sqlite3 compiled for a different Node version).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

describe("hook safeHookAction wrapper", () => {
  let exitMock: ReturnType<typeof vi.spyOn>;
  let stderrMock: ReturnType<typeof vi.spyOn>;
  let exitCalls: (string | number | null | undefined)[];
  let stderrOutput: string[];

  beforeEach(() => {
    exitCalls = [];
    stderrOutput = [];
    exitMock = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null | undefined,
    ) => {
      exitCalls.push(code);
      throw new Error(`__exit_${code}__`); // halt execution like real exit
    }) as never);
    stderrMock = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrOutput.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    exitMock.mockRestore();
    stderrMock.mockRestore();
    vi.restoreAllMocks();
  });

  it("exits 0 with native module hint on ERR_DLOPEN_FAILED", async () => {
    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    // Find the post-tool-use action by simulating an error inside it.
    // Easier path: directly test by constructing a minimal action and
    // wrapping it via the same mechanism. Since safeHookAction is not
    // exported, we test via the registered commands.

    // Stub stdin so the hook reads empty input. The hook should still
    // not crash; native module errors are caught at any point in the flow.

    // Trigger a hook with an error: throw a synthetic ERR_DLOPEN_FAILED
    // by mocking Db. We test the wrapper indirectly by importing the
    // hook module fresh and verifying that exit(0) is called when an
    // injected error occurs.

    // Since the wrapper is internal, we verify behavior via the
    // process.on('uncaughtException') handler installed alongside it.
    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    expect(handler).toBeDefined();

    const dlopenErr = new Error(
      "The module 'foo.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 120",
    ) as NodeJS.ErrnoException;
    dlopenErr.code = "ERR_DLOPEN_FAILED";

    expect(() => handler!(dlopenErr)).toThrow("__exit_0__");
    expect(exitCalls).toContain(0);
    expect(stderrOutput.join("")).toContain("Native module ABI mismatch");
    expect(stderrOutput.join("")).toContain("npm rebuild");
  });

  it("exits 0 with generic message on other errors", async () => {
    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    expect(handler).toBeDefined();

    const genericErr = new Error("something went wrong");
    expect(() => handler!(genericErr)).toThrow("__exit_0__");
    expect(exitCalls).toContain(0);
    expect(stderrOutput.join("")).toContain("uncaught");
    expect(stderrOutput.join("")).toContain("something went wrong");
  });

  it("detects NODE_MODULE_VERSION substring without ERR_DLOPEN_FAILED code", async () => {
    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("uncaughtException").at(-1) as
      | ((err: Error) => void)
      | undefined;
    expect(handler).toBeDefined();

    const err = new Error(
      "module foo was compiled against a different Node.js version",
    );
    expect(() => handler!(err)).toThrow("__exit_0__");
    expect(stderrOutput.join("")).toContain("Native module ABI mismatch");
  });

  it("unhandled rejection handler also exits 0", async () => {
    const program = new Command();
    const { registerHookCommands } = await import("../../src/cli/hook.js");
    registerHookCommands(program);

    const handler = process.listeners("unhandledRejection").at(-1) as
      | ((reason: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    expect(() => handler!(new Error("rejected"))).toThrow("__exit_0__");
    expect(exitCalls).toContain(0);
    expect(stderrOutput.join("")).toContain("unhandled rejection");
  });
});
