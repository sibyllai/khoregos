/**
 * Daemon lifecycle management for the K6s governance engine.
 *
 * The daemon is fire-and-forget: `k6s team start` sets up governance and exits.
 * Session liveness is tracked by the presence of .khoregos/daemon.state.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Write a file and set owner-only permissions (0o600). */
function writeSecureFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o600 });
  // chmod explicitly in case the file already existed with wider perms.
  chmodSync(filePath, 0o600);
}

export class DaemonState {
  readonly stateFile: string;

  constructor(private khoregoDir: string) {
    this.stateFile = path.join(khoregoDir, "daemon.state");
  }

  isRunning(): boolean {
    return existsSync(this.stateFile);
  }

  writeState(state: Record<string, unknown>): void {
    mkdirSync(this.khoregoDir, { recursive: true });
    chmodSync(this.khoregoDir, 0o700);
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    chmodSync(this.stateFile, 0o600);
  }

  readState(): Record<string, unknown> {
    if (!existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf-8"));
    } catch {
      return {};
    }
  }

  removeState(): void {
    if (existsSync(this.stateFile)) unlinkSync(this.stateFile);
  }
}

export function injectClaudeMdGovernance(
  projectRoot: string,
  sessionId: string,
): void {
  const claudeDir = path.join(projectRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const claudeMd = path.join(claudeDir, "CLAUDE.md");

  const governanceSection = `

## Khoregos Governance (Auto-generated — do not edit)

This project uses Khoregos (k6s) for governance. Session ID: ${sessionId}

All agents MUST:

1. **Log significant actions** using the \`k6s_log\` MCP tool before and after:
   - Creating or modifying files
   - Making architectural decisions
   - Completing tasks

2. **Check boundaries** using \`k6s_get_boundaries\` at session start
   - Only modify files within your allowed paths
   - Never touch forbidden paths
   - Use \`k6s_check_path\` before modifying any file you're unsure about

3. **Use file locks** via \`k6s_acquire_lock\` / \`k6s_release_lock\` when
   editing shared files to prevent conflicts

4. **Save context** using \`k6s_save_context\` when:
   - Making important decisions (save rationale)
   - Completing major milestones
   - Before ending your session

5. **Load context** using \`k6s_load_context\` to retrieve previously saved state

<!-- K6S_GOVERNANCE_END -->
`;

  let existing = "";
  if (existsSync(claudeMd)) {
    existing = readFileSync(claudeMd, "utf-8");
  }

  // Remove existing governance section
  if (existing.includes("## Khoregos Governance")) {
    const start = existing.indexOf("## Khoregos Governance");
    const end = existing.indexOf("<!-- K6S_GOVERNANCE_END -->");
    if (end !== -1) {
      const endFull = end + "<!-- K6S_GOVERNANCE_END -->".length;
      existing = existing.slice(0, start) + existing.slice(endFull);
    }
  }

  writeSecureFile(claudeMd, existing.trimEnd() + governanceSection);
}

export function removeClaudeMdGovernance(projectRoot: string): void {
  const claudeMd = path.join(projectRoot, ".claude", "CLAUDE.md");
  if (!existsSync(claudeMd)) return;

  const content = readFileSync(claudeMd, "utf-8");
  if (!content.includes("## Khoregos Governance")) return;

  const start = content.indexOf("## Khoregos Governance");
  const end = content.indexOf("<!-- K6S_GOVERNANCE_END -->");
  if (end !== -1) {
    const endFull = end + "<!-- K6S_GOVERNANCE_END -->".length;
    const newContent = content.slice(0, start).trimEnd() + content.slice(endFull);
    writeSecureFile(claudeMd, newContent);
  }
}

function loadClaudeSettings(
  projectRoot: string,
): [filePath: string, settings: Record<string, unknown>] {
  const settingsDir = path.join(projectRoot, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const filePath = path.join(settingsDir, "settings.json");

  if (existsSync(filePath)) {
    try {
      return [filePath, JSON.parse(readFileSync(filePath, "utf-8"))];
    } catch {
      // corrupt file
    }
  }
  return [filePath, {}];
}

export function registerMcpServer(projectRoot: string): void {
  const [filePath, settings] = loadClaudeSettings(projectRoot);
  if (!settings.mcpServers) settings.mcpServers = {};
  (settings.mcpServers as Record<string, unknown>).khoregos = {
    command: "k6s",
    args: ["mcp", "serve"],
  };
  writeSecureFile(filePath, JSON.stringify(settings, null, 2));
}

export function unregisterMcpServer(projectRoot: string): void {
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsFile)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    const servers = settings.mcpServers as Record<string, unknown> | undefined;
    if (servers?.khoregos) {
      delete servers.khoregos;
      writeSecureFile(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // ignore corrupt file
  }
}

export function registerHooks(projectRoot: string): void {
  const [filePath, settings] = loadClaudeSettings(projectRoot);

  settings.hooks = {
    PostToolUse: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "k6s hook post-tool-use", timeout: 10 },
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "k6s hook subagent-start", timeout: 10 },
        ],
      },
    ],
    SubagentStop: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "k6s hook subagent-stop", timeout: 10 },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: "k6s hook session-stop", timeout: 10 },
        ],
      },
    ],
  };

  writeSecureFile(filePath, JSON.stringify(settings, null, 2));
}

export function unregisterHooks(projectRoot: string): void {
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsFile)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    if (settings.hooks) {
      delete settings.hooks;
      writeSecureFile(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // ignore corrupt file
  }
}
