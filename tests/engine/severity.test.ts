/**
 * Tests for classifySeverity and extractPathsFromBashCommand.
 */

import { describe, it, expect } from "vitest";
import {
  classifySeverity,
  extractPathsFromBashCommand,
} from "../../src/engine/severity.js";

describe("classifySeverity", () => {
  it("returns critical for boundary violation", () => {
    expect(
      classifySeverity({
        eventType: "tool_use",
        action: "read",
        isBoundaryViolation: true,
      }),
    ).toBe("critical");
  });

  it("returns critical when files match critical patterns", () => {
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: [".env"],
      }),
    ).toBe("critical");
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: ["app/auth/login.ts"],
      }),
    ).toBe("critical");
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: ["secrets/foo.pem"],
      }),
    ).toBe("critical");
  });

  it("returns warning when files match warning patterns", () => {
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: ["package.json"],
      }),
    ).toBe("warning");
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: ["requirements.txt", "src/other.ts"],
      }),
    ).toBe("warning");
  });

  it("returns info when no sensitive files or actions", () => {
    expect(
      classifySeverity({
        eventType: "tool_use",
        action: "read_file",
        filesAffected: ["src/main.ts"],
      }),
    ).toBe("info");
  });

  it("returns warning for dangerous bash commands", () => {
    expect(
      classifySeverity({
        eventType: "tool_use",
        action: "bash: rm -rf /tmp/foo",
        filesAffected: [],
      }),
    ).toBe("warning");
    expect(
      classifySeverity({
        eventType: "tool_use",
        action: "bash: chmod 777 script.sh",
        filesAffected: [],
      }),
    ).toBe("warning");
  });

  it("prefers critical over warning when both match", () => {
    expect(
      classifySeverity({
        eventType: "file_modify",
        action: "edit",
        filesAffected: [".env", "package.json"],
      }),
    ).toBe("critical");
  });
});

describe("extractPathsFromBashCommand", () => {
  it("returns empty array for empty or whitespace", () => {
    expect(extractPathsFromBashCommand("")).toEqual([]);
    expect(extractPathsFromBashCommand("   ")).toEqual([]);
  });

  it("extracts quoted paths that do not look like MIME types", () => {
    const paths = extractPathsFromBashCommand('cat "src/foo/bar"');
    expect(paths).toContain("src/foo/bar");
  });

  it("extracts unquoted path-like tokens", () => {
    const paths = extractPathsFromBashCommand("node src/scripts/build");
    expect(paths.some((p) => p.includes("src") && p.includes("scripts"))).toBe(true);
  });

  it("rejects URLs", () => {
    const paths = extractPathsFromBashCommand('curl "https://example.com/file"');
    expect(paths.some((p) => p.startsWith("http"))).toBe(false);
  });

  it("rejects /dev/null and virtual paths", () => {
    const paths = extractPathsFromBashCommand("echo foo > /dev/null");
    expect(paths).not.toContain("/dev/null");
  });

  it("does not include known commands as paths", () => {
    const paths = extractPathsFromBashCommand("npm install && npx tsc");
    expect(paths).not.toContain("npm");
    expect(paths).not.toContain("npx");
  });

  it("limits to 10 paths", () => {
    const long = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`).join(" ");
    const paths = extractPathsFromBashCommand(long);
    expect(paths.length).toBeLessThanOrEqual(10);
  });
});
