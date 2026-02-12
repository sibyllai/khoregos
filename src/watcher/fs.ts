/**
 * Filesystem watcher for gate trigger detection.
 *
 * Uses chokidar to monitor file changes and emit audit events.
 * Matches file changes against gate trigger patterns.
 */

import path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import picomatch from "picomatch";
import type { AuditLogger } from "../engine/audit.js";
import type { BoundaryEnforcer } from "../engine/boundaries.js";
import type { EventBus } from "../engine/events.js";
import type { GateConfig } from "../models/config.js";

const IGNORED_DIRS = [
  ".git",
  ".khoregos",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  ".next",
];

export class GatePatternMatcher {
  private matchers: Map<string, picomatch.Matcher[]> = new Map();

  constructor(gates: GateConfig[]) {
    for (const gate of gates) {
      const patterns = gate.trigger.file_patterns ?? [];
      if (patterns.length > 0) {
        this.matchers.set(
          gate.id,
          patterns.map((p: string) => picomatch(p)),
        );
      }
    }
  }

  matchingGates(filePath: string): string[] {
    const matched: string[] = [];
    for (const [gateId, matchers] of this.matchers) {
      if (matchers.some((m) => m(filePath))) {
        matched.push(gateId);
      }
    }
    return matched;
  }
}

export interface FilesystemWatcherOptions {
  projectRoot: string;
  sessionId: string;
  auditLogger: AuditLogger;
  boundaryEnforcer?: BoundaryEnforcer;
  eventBus?: EventBus;
  gates?: GateConfig[];
}

export class FilesystemWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private sessionId: string;
  private auditLogger: AuditLogger;
  private boundaryEnforcer?: BoundaryEnforcer;
  private eventBus?: EventBus;
  private patternMatcher: GatePatternMatcher;

  constructor(opts: FilesystemWatcherOptions) {
    this.projectRoot = opts.projectRoot;
    this.sessionId = opts.sessionId;
    this.auditLogger = opts.auditLogger;
    this.boundaryEnforcer = opts.boundaryEnforcer;
    this.eventBus = opts.eventBus;
    this.patternMatcher = new GatePatternMatcher(opts.gates ?? []);
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.projectRoot, {
      ignored: IGNORED_DIRS.map((d) => path.join(this.projectRoot, d)),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on("add", (fp) => this.handleEvent(fp, "file_create"));
    this.watcher.on("change", (fp) => this.handleEvent(fp, "file_modify"));
    this.watcher.on("unlink", (fp) => this.handleEvent(fp, "file_delete"));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleEvent(
    absolutePath: string,
    eventType: "file_create" | "file_modify" | "file_delete",
  ): void {
    const relativePath = path.relative(this.projectRoot, absolutePath);

    const event = this.auditLogger.log({
      eventType,
      action: `${eventType}: ${relativePath}`,
      filesAffected: [relativePath],
    });

    if (this.eventBus) {
      this.eventBus.publish(event);
    }

    const matchedGates = this.patternMatcher.matchingGates(relativePath);
    if (matchedGates.length > 0) {
      this.auditLogger.log({
        eventType: "gate_triggered",
        action: `Gate pattern matched: ${relativePath}`,
        details: {
          file: relativePath,
          gates: matchedGates,
          trigger_event: eventType,
        },
        filesAffected: [relativePath],
      });
    }
  }
}
