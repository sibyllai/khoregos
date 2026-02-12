/**
 * Boundary enforcer for agent file access control.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { ulid } from "ulid";
import type { Db } from "../store/db.js";
import type { BoundaryConfig } from "../models/config.js";
import {
  type BoundaryViolation,
  boundaryViolationFromDbRow,
  boundaryViolationToDbRow,
} from "../models/context.js";

export class BoundaryEnforcer {
  constructor(
    private db: Db,
    private sessionId: string,
    private projectRoot: string,
    private boundaries: BoundaryConfig[],
  ) {}

  getBoundaryForAgent(agentName: string): BoundaryConfig | null {
    for (const b of this.boundaries) {
      if (picomatch.isMatch(agentName, b.pattern)) return b;
    }
    for (const b of this.boundaries) {
      if (b.pattern === "*") return b;
    }
    return null;
  }

  checkPathAllowed(
    filePath: string,
    agentName: string,
  ): [allowed: boolean, reason: string | null] {
    const boundary = this.getBoundaryForAgent(agentName);
    if (!boundary) {
      return [
        false,
        `No boundary configured for agent '${agentName}'; denied by default`,
      ];
    }

    // Resolve symlinks and normalize to get the real path,
    // then verify it still falls under the project root.
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(this.projectRoot);
    } catch {
      resolvedRoot = path.resolve(this.projectRoot);
    }

    let resolved: string;
    if (path.isAbsolute(filePath)) {
      try {
        resolved = realpathSync(filePath);
      } catch {
        resolved = path.resolve(filePath);
      }
    } else {
      try {
        resolved = realpathSync(path.join(resolvedRoot, filePath));
      } catch {
        resolved = path.resolve(resolvedRoot, filePath);
      }
    }

    const rel = path.relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return [false, `Path ${filePath} resolves outside project root`];
    }

    // Normalize to posix for matching
    const posixPath = rel.split(path.sep).join("/");

    // Check forbidden paths first (they take precedence)
    for (const pattern of boundary.forbidden_paths) {
      if (picomatch.isMatch(posixPath, pattern, { dot: true })) {
        return [false, `Path matches forbidden pattern: ${pattern}`];
      }
    }

    // If allowed_paths is specified, path must match at least one
    if (boundary.allowed_paths.length > 0) {
      for (const pattern of boundary.allowed_paths) {
        if (picomatch.isMatch(posixPath, pattern, { dot: true })) {
          return [true, null];
        }
      }
      return [
        false,
        `Path does not match any allowed patterns for ${agentName}`,
      ];
    }

    return [true, null];
  }

  recordViolation(opts: {
    filePath: string;
    agentId?: string | null;
    violationType: string;
    enforcementAction: string;
    details?: Record<string, unknown>;
  }): BoundaryViolation {
    const violation: BoundaryViolation = {
      id: ulid(),
      sessionId: this.sessionId,
      agentId: opts.agentId ?? null,
      timestamp: new Date().toISOString(),
      filePath: opts.filePath,
      violationType: opts.violationType,
      enforcementAction: opts.enforcementAction,
      details: opts.details ? JSON.stringify(opts.details) : null,
    };

    this.db.insert("boundary_violations", boundaryViolationToDbRow(violation));
    return violation;
  }

  getViolations(agentId?: string, limit = 100): BoundaryViolation[] {
    if (agentId) {
      return this.db
        .fetchAll(
          `SELECT * FROM boundary_violations
         WHERE session_id = ? AND agent_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
          [this.sessionId, agentId, limit],
        )
        .map(boundaryViolationFromDbRow);
    }
    return this.db
      .fetchAll(
        `SELECT * FROM boundary_violations
       WHERE session_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
        [this.sessionId, limit],
      )
      .map(boundaryViolationFromDbRow);
  }

  getAgentBoundariesSummary(agentName: string): Record<string, unknown> {
    const boundary = this.getBoundaryForAgent(agentName);
    if (!boundary) {
      return {
        agent: agentName,
        has_boundary: false,
        allowed_paths: [],
        forbidden_paths: [],
        enforcement: "deny",
      };
    }
    return {
      agent: agentName,
      has_boundary: true,
      allowed_paths: boundary.allowed_paths,
      forbidden_paths: boundary.forbidden_paths,
      enforcement: boundary.enforcement,
      max_tokens_per_hour: boundary.max_tokens_per_hour,
      max_cost_per_hour: boundary.max_cost_per_hour,
    };
  }
}
