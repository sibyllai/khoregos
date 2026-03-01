/**
 * Tests for plugin loading, dispatch, and global accessor behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PluginManager, getPluginManager, setPluginManager } from "../../src/engine/plugins.js";
import type { AuditEvent } from "../../src/models/audit.js";

type PluginConfig = {
  name: string;
  module: string;
  config: Record<string, unknown>;
};

describe("PluginManager", () => {
  let tempDir: string;
  let moduleCounter = 0;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function writeModule(name: string, source: string): string {
    moduleCounter += 1;
    const filePath = path.join(tempDir, `${name}-${moduleCounter}.mjs`);
    writeFileSync(filePath, source, "utf-8");
    return `${pathToFileURL(filePath).href}?v=${moduleCounter}`;
  }

  function sampleEvent(): AuditEvent {
    return {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      timestamp: new Date().toISOString(),
      sequence: 1,
      sessionId: "session-test",
      agentId: "agent-test",
      eventType: "tool_use",
      action: "tool use",
      details: null,
      filesAffected: null,
      gateId: null,
      hmac: null,
      severity: "info",
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "k6s-plugins-test-"));
    moduleCounter = 0;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setPluginManager(null);
  });

  afterEach(() => {
    setPluginManager(null);
    errorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loadPlugins loads a valid factory function", async () => {
    const manager = new PluginManager();
    const validModule = writeModule(
      "valid",
      `
      export default function createPlugin() {
        return {
          name: "valid-plugin",
          onSessionStart(ctx) {
            ctx.log("session start ok");
          },
        };
      }
      `,
    );
    const configs: PluginConfig[] = [
      { name: "valid", module: validModule, config: { enabled: true } },
    ];

    await manager.loadPlugins(configs, "session-1", "/tmp/project");
    await manager.callSessionStart();

    expect(errorSpy).toHaveBeenCalledWith("[k6s:plugin:valid] session start ok");
  });

  it("loadPlugins skips invalid module default export and continues", async () => {
    const manager = new PluginManager();
    const invalidModule = writeModule(
      "invalid",
      `
      export default { not: "a function" };
      `,
    );
    const validModule = writeModule(
      "valid",
      `
      export default function createPlugin() {
        return {
          name: "valid-plugin",
          onSessionStart(ctx) {
            ctx.log("valid start");
          },
        };
      }
      `,
    );
    const configs: PluginConfig[] = [
      { name: "invalid", module: invalidModule, config: {} },
      { name: "valid", module: validModule, config: {} },
    ];

    await manager.loadPlugins(configs, "session-1", "/tmp/project");
    await manager.callSessionStart();

    expect(errorSpy).toHaveBeenCalledWith(
      "[k6s] plugin 'invalid': default export is not a function, skipping.",
    );
    expect(errorSpy).toHaveBeenCalledWith("[k6s:plugin:valid] valid start");
  });

  it("loadPlugins logs import errors and continues", async () => {
    const manager = new PluginManager();
    const brokenModule = writeModule(
      "broken",
      `
      throw new Error("import exploded");
      `,
    );
    const validModule = writeModule(
      "valid",
      `
      export default function createPlugin() {
        return {
          name: "valid-plugin",
          onSessionStart(ctx) {
            ctx.log("valid loaded after broken");
          },
        };
      }
      `,
    );
    const configs: PluginConfig[] = [
      { name: "broken", module: brokenModule, config: {} },
      { name: "valid", module: validModule, config: {} },
    ];

    await manager.loadPlugins(configs, "session-1", "/tmp/project");
    await manager.callSessionStart();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[k6s] failed to load plugin 'broken': import exploded."),
    );
    expect(errorSpy).toHaveBeenCalledWith("[k6s:plugin:valid] valid loaded after broken");
  });

  it("callSessionStart and callSessionStop await lifecycle hooks", async () => {
    const manager = new PluginManager();
    const firstModule = writeModule(
      "first",
      `
      export default function createPlugin() {
        return {
          name: "first",
          async onSessionStart(ctx) {
            ctx.log("start:first:begin");
            await new Promise((resolve) => setTimeout(resolve, 5));
            ctx.log("start:first:end");
          },
          async onSessionStop(ctx) {
            ctx.log("stop:first:begin");
            await new Promise((resolve) => setTimeout(resolve, 5));
            ctx.log("stop:first:end");
          },
        };
      }
      `,
    );
    const secondModule = writeModule(
      "second",
      `
      export default function createPlugin() {
        return {
          name: "second",
          onSessionStart(ctx) {
            ctx.log("start:second");
          },
          onSessionStop(ctx) {
            ctx.log("stop:second");
          },
        };
      }
      `,
    );
    const configs: PluginConfig[] = [
      { name: "first", module: firstModule, config: {} },
      { name: "second", module: secondModule, config: {} },
    ];

    await manager.loadPlugins(configs, "session-1", "/tmp/project");
    await manager.callSessionStart();
    await manager.callSessionStop();

    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(messages).toEqual(
      expect.arrayContaining([
        "[k6s:plugin:first] start:first:begin",
        "[k6s:plugin:first] start:first:end",
        "[k6s:plugin:second] start:second",
        "[k6s:plugin:first] stop:first:begin",
        "[k6s:plugin:first] stop:first:end",
        "[k6s:plugin:second] stop:second",
      ]),
    );
    expect(messages.indexOf("[k6s:plugin:first] start:first:end")).toBeLessThan(
      messages.indexOf("[k6s:plugin:second] start:second"),
    );
    expect(messages.indexOf("[k6s:plugin:first] stop:first:end")).toBeLessThan(
      messages.indexOf("[k6s:plugin:second] stop:second"),
    );
  });

  it("callAuditEvent is fire-and-forget and catches synchronous hook errors", async () => {
    const manager = new PluginManager();
    const syncThrowModule = writeModule(
      "sync-throw",
      `
      export default function createPlugin() {
        return {
          name: "sync-throw",
          onAuditEvent() {
            throw new Error("sync failure");
          },
        };
      }
      `,
    );
    await manager.loadPlugins(
      [{ name: "sync-throw", module: syncThrowModule, config: {} }],
      "session-1",
      "/tmp/project",
    );

    expect(() => manager.callAuditEvent(sampleEvent())).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "[k6s:plugin:sync-throw] onAuditEvent error: sync failure.",
    );
  });

  it("callAuditEvent catches rejected async hook errors without throwing", async () => {
    const manager = new PluginManager();
    const asyncRejectModule = writeModule(
      "async-reject",
      `
      export default function createPlugin() {
        return {
          name: "async-reject",
          async onAuditEvent() {
            throw new Error("async failure");
          },
        };
      }
      `,
    );
    await manager.loadPlugins(
      [{ name: "async-reject", module: asyncRejectModule, config: {} }],
      "session-1",
      "/tmp/project",
    );

    expect(() => manager.callAuditEvent(sampleEvent())).not.toThrow();
    await delay(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "[k6s:plugin:async-reject] onAuditEvent error: async failure.",
    );
  });

  it("setPluginManager and getPluginManager roundtrip", () => {
    const manager = new PluginManager();

    setPluginManager(manager);
    expect(getPluginManager()).toBe(manager);

    setPluginManager(null);
    expect(getPluginManager()).toBeNull();
  });
});
