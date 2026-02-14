/**
 * Security event severity classification for audit events.
 *
 * Hardcoded rules per Phase 2 plan; configurable later via plugin.
 */

import picomatch from "picomatch";
import type { AuditSeverity } from "../models/audit.js";

const CRITICAL_PATTERNS = [
  ".env*",
  "**/auth/**",
  "**/security/**",
  "**/*.pem",
  "**/*.key",
];

const WARNING_PATTERNS = [
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "**/pom.xml",
];

const criticalMatchers = CRITICAL_PATTERNS.map((p) => picomatch(p));
const warningDependencyMatchers = WARNING_PATTERNS.map((p) => picomatch(p));

function pathMatches(matchers: picomatch.Matcher[], relativePath: string): boolean {
  return matchers.some((m) => m(relativePath));
}

/**
 * Classify severity from event type, action text, and files affected.
 */
export function classifySeverity(opts: {
  eventType: string;
  action: string;
  filesAffected?: string[] | null;
  isBoundaryViolation?: boolean;
}): AuditSeverity {
  if (opts.isBoundaryViolation) return "critical";

  const actionLower = opts.action.toLowerCase();
  const files = opts.filesAffected ?? [];

  for (const f of files) {
    if (pathMatches(criticalMatchers, f)) return "critical";
  }

  for (const f of files) {
    if (pathMatches(warningDependencyMatchers, f)) return "warning";
  }

  if (opts.eventType === "tool_use" && actionLower.includes("bash")) {
    if (
      /\b(rm\s|kill\s|chmod\s|chown\s|curl\s|wget\s)/.test(actionLower) ||
      /^\s*rm\s/.test(actionLower)
    ) {
      return "warning";
    }
  }

  return "info";
}

/**
 * Heuristic: extract file-like paths from a Bash command string.
 * Used to populate filesAffected for Bash tool_use when not available from tool_input.
 *
 * Deliberately conservative: filters out URLs, JSON fragments, bare words,
 * and other strings that look like paths but aren't.
 */
export function extractPathsFromBashCommand(command: string): string[] {
  const paths: string[] = [];
  const trimmed = command.trim();
  if (!trimmed) return paths;

  function isLikelyPath(s: string): boolean {
    // Must contain a slash or start with ./ ../.
    if (!s.includes("/") && !s.startsWith(".")) return false;
    // Reject URLs.
    if (/^https?:\/\//i.test(s)) return false;
    // Reject bare protocol-like strings.
    if (/^[a-z]+:\/\//i.test(s)) return false;
    // Reject JSON fragments.
    if (s.startsWith("{") || s.startsWith("[") || s.startsWith('"')) return false;
    // Reject MIME types (e.g. application/json, text/html).
    if (/^[a-z]+\/[a-z+.-]+$/i.test(s)) return false;
    // Reject HTTP headers (e.g. Content-Type: application/json).
    if (/^[A-Z][a-z]+-[A-Z][a-z]+:/i.test(s)) return false;
    // Reject flags.
    if (s.startsWith("-")) return false;
    // Reject pipe expressions and redirections embedded in tokens.
    if (s.includes("|")) return false;
    // Reject shell redirections (e.g. 2>/dev/null).
    if (/^\d*>[>&]/.test(s)) return false;
    // Reject /dev/null and other virtual paths.
    if (s === "/dev/null" || s.startsWith("/dev/")) return false;
    // Reject require()/import() wrappers — these reference code, not files being modified.
    if (/^require\(/.test(s) || /^import\(/.test(s)) return false;
    // Reject Node.js inline expressions (e.g. app.get('/path')).
    if (/^\w+\.\w+\(/.test(s)) return false;
    // Reject console.log and similar JS method calls.
    if (/^console\./.test(s)) return false;
    // Must start with /, ./, ../, or a word character (relative path).
    if (!/^[.\/\w~]/.test(s)) return false;
    // Reject very short tokens that are probably commands, not paths.
    if (s.length < 3 && !s.includes("/")) return false;
    return true;
  }

  // Quoted strings that look like filesystem paths.
  const quoted = trimmed.matchAll(/["']([^"']+)["']/g);
  for (const m of quoted) {
    const p = m[1].trim();
    if (isLikelyPath(p)) paths.push(p);
  }

  // Unquoted tokens that look like filesystem paths.
  const tokens = trimmed.split(/\s+/);
  const knownCommands = new Set([
    "ls", "cd", "cat", "echo", "npm", "npx", "node", "git", "mkdir",
    "cp", "mv", "rm", "touch", "chmod", "chown", "curl", "wget",
    "kill", "sleep", "head", "tail", "grep", "find", "xargs",
    "python", "python3", "pip", "pip3", "ruby", "go", "cargo",
    "docker", "kubectl", "ssh", "scp", "tar", "gzip", "unzip",
  ]);
  for (const t of tokens) {
    const cleaned = t.replace(/^["']|["']$/g, "").replace(/[;,]$/, "");
    if (knownCommands.has(cleaned)) continue;
    if (isLikelyPath(cleaned)) {
      paths.push(cleaned);
    }
  }

  return [...new Set(paths)].slice(0, 10);
}
