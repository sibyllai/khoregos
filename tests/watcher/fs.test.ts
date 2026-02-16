/**
 * Tests for ReviewPatternMatcher (gate pattern matching).
 */

import { describe, it, expect } from "vitest";
import { ReviewPatternMatcher } from "../../src/watcher/fs.js";
import type { GateConfig } from "../../src/models/config.js";

describe("ReviewPatternMatcher", () => {
  const gates: GateConfig[] = [
    {
      id: "dep",
      name: "Dependency",
      trigger: { file_patterns: ["package.json", "requirements.txt", "**/pom.xml"] },
      approval_mode: "manual",
      timeout_seconds: 1800,
      notify: ["terminal"],
    },
    {
      id: "sec",
      name: "Security",
      trigger: { file_patterns: [".env*", "**/auth/**", "**/*.pem"] },
      approval_mode: "manual",
      notify: ["terminal"],
    },
  ];

  it("matchingRules returns empty when no rule matches", () => {
    const matcher = new ReviewPatternMatcher(gates);
    expect(matcher.matchingRules("src/foo.ts")).toEqual([]);
  });

  it("matchingRules returns rule ids when file matches", () => {
    const matcher = new ReviewPatternMatcher(gates);
    expect(matcher.matchingRules("package.json")).toContain("dep");
    expect(matcher.matchingRules("requirements.txt")).toContain("dep");
    expect(matcher.matchingRules("backend/pom.xml")).toContain("dep");
  });

  it("matchingRules matches security patterns", () => {
    const matcher = new ReviewPatternMatcher(gates);
    expect(matcher.matchingRules(".env")).toContain("sec");
    expect(matcher.matchingRules(".env.local")).toContain("sec");
    expect(matcher.matchingRules("lib/auth/helper.ts")).toContain("sec");
    expect(matcher.matchingRules("keys/cert.pem")).toContain("sec");
  });

  it("matchingRules can match multiple rules", () => {
    const matcher = new ReviewPatternMatcher(gates);
    const rules = matcher.matchingRules("package.json");
    expect(rules).toContain("dep");
  });

  it("handles gates with no file_patterns", () => {
    const emptyGates: GateConfig[] = [
      {
        id: "no-patterns",
        name: "No patterns",
        trigger: {},
        approval_mode: "manual",
        notify: [],
      },
    ];
    const matcher = new ReviewPatternMatcher(emptyGates);
    expect(matcher.matchingRules("any/file.txt")).toEqual([]);
  });
});
