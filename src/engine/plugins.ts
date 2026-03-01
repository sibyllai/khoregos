/**
 * Plugin system for extensible governance hooks.
 */

import type { AuditEvent } from "../models/audit.js";
import type { BoundaryViolation } from "../models/context.js";

export interface K6sPluginContext {
  sessionId: string;
  projectRoot: string;
  config: Record<string, unknown>;
  log: (message: string) => void;
}

export interface K6sPlugin {
  name: string;
  onSessionStart?(ctx: K6sPluginContext): void | Promise<void>;
  onSessionStop?(ctx: K6sPluginContext): void | Promise<void>;
  onAuditEvent?(ctx: K6sPluginContext, event: AuditEvent): void | Promise<void>;
  onToolUse?(ctx: K6sPluginContext, event: AuditEvent): void | Promise<void>;
  onGateTrigger?(ctx: K6sPluginContext, event: AuditEvent): void | Promise<void>;
  onBoundaryViolation?(ctx: K6sPluginContext, violation: BoundaryViolation): void | Promise<void>;
}

export type K6sPluginFactory = (config: Record<string, unknown>) => K6sPlugin;

type LoadedPlugin = {
  plugin: K6sPlugin;
  ctx: K6sPluginContext;
};

type PluginConfig = {
  name: string;
  module: string;
  config: Record<string, unknown>;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPromise<T>(value: Promise<T> | T): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

export class PluginManager {
  private plugins: LoadedPlugin[] = [];

  async loadPlugins(
    pluginConfigs: PluginConfig[],
    sessionId: string,
    projectRoot: string,
  ): Promise<void> {
    for (const pluginConfig of pluginConfigs) {
      try {
        const mod = await import(pluginConfig.module);
        const factory = mod.default;

        if (typeof factory !== "function") {
          console.error(
            `[k6s] plugin '${pluginConfig.name}': default export is not a function, skipping.`,
          );
          continue;
        }

        const typedFactory = factory as K6sPluginFactory;
        const plugin = typedFactory(pluginConfig.config);
        const ctx: K6sPluginContext = {
          sessionId,
          projectRoot,
          config: pluginConfig.config,
          log: (message: string) => {
            console.error(`[k6s:plugin:${pluginConfig.name}] ${message}`);
          },
        };

        this.plugins.push({ plugin, ctx });
      } catch (err: unknown) {
        console.error(
          `[k6s] failed to load plugin '${pluginConfig.name}': ${toErrorMessage(err)}.`,
        );
      }
    }
  }

  async callSessionStart(): Promise<void> {
    for (const { plugin, ctx } of this.plugins) {
      if (!plugin.onSessionStart) continue;
      try {
        await plugin.onSessionStart(ctx);
      } catch (err: unknown) {
        ctx.log(`onSessionStart error: ${toErrorMessage(err)}.`);
      }
    }
  }

  async callSessionStop(): Promise<void> {
    for (const { plugin, ctx } of this.plugins) {
      if (!plugin.onSessionStop) continue;
      try {
        await plugin.onSessionStop(ctx);
      } catch (err: unknown) {
        ctx.log(`onSessionStop error: ${toErrorMessage(err)}.`);
      }
    }
  }

  callAuditEvent(event: AuditEvent): void {
    this.callEventHook(
      "onAuditEvent",
      "onAuditEvent",
      event,
      (plugin, ctx, payload) => plugin.onAuditEvent?.(ctx, payload),
    );
  }

  callToolUse(event: AuditEvent): void {
    this.callEventHook(
      "onToolUse",
      "onToolUse",
      event,
      (plugin, ctx, payload) => plugin.onToolUse?.(ctx, payload),
    );
  }

  callGateTrigger(event: AuditEvent): void {
    this.callEventHook(
      "onGateTrigger",
      "onGateTrigger",
      event,
      (plugin, ctx, payload) => plugin.onGateTrigger?.(ctx, payload),
    );
  }

  callBoundaryViolation(violation: BoundaryViolation): void {
    this.callEventHook(
      "onBoundaryViolation",
      "onBoundaryViolation",
      violation,
      (plugin, ctx, payload) => plugin.onBoundaryViolation?.(ctx, payload),
    );
  }

  private callEventHook<T>(
    hookName: string,
    errorLabel: string,
    payload: T,
    invoke: (
      plugin: K6sPlugin,
      ctx: K6sPluginContext,
      payload: T,
    ) => Promise<void> | void | undefined,
  ): void {
    for (const { plugin, ctx } of this.plugins) {
      if (!(hookName in plugin)) continue;
      try {
        const result = invoke(plugin, ctx, payload);
        if (isPromise(result)) {
          result.catch((err: unknown) => {
            ctx.log(`${errorLabel} error: ${toErrorMessage(err)}.`);
          });
        }
      } catch (err: unknown) {
        ctx.log(`${errorLabel} error: ${toErrorMessage(err)}.`);
      }
    }
  }
}

let globalPluginManager: PluginManager | null = null;

export function setPluginManager(manager: PluginManager | null): void {
  globalPluginManager = manager;
}

export function getPluginManager(): PluginManager | null {
  return globalPluginManager;
}
