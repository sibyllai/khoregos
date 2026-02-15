/**
 * Khoregos — Enterprise governance layer for Claude Code Agent Teams.
 */

export { Db, getDatabase, closeDatabase } from "./store/db.js";
export { SCHEMA_VERSION } from "./store/migrations.js";

export type { Session } from "./models/session.js";
export type { Agent } from "./models/agent.js";
export type { AuditEvent } from "./models/audit.js";
export type { ContextEntry, FileLock, BoundaryViolation } from "./models/context.js";
export type { K6sConfig, BoundaryConfig, GateConfig } from "./models/config.js";
export { loadConfig, saveConfig, generateDefaultConfig } from "./models/config.js";

export { AuditLogger } from "./engine/audit.js";
export {
  generateSigningKey,
  loadSigningKey,
  verifyChain,
} from "./engine/signing.js";
export { BoundaryEnforcer } from "./engine/boundaries.js";
export { FileLockManager } from "./engine/locks.js";
export { StateManager } from "./engine/state.js";
export { EventBus } from "./engine/events.js";

export { K6sServer } from "./mcp/server.js";

export { DaemonState } from "./daemon/manager.js";

export { FilesystemWatcher, GatePatternMatcher } from "./watcher/fs.js";
