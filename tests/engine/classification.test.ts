/**
 * Tests for classification resolver behavior.
 */

import { describe, expect, it } from "vitest";
import { ClassificationResolver } from "../../src/engine/classification.js";
import type { ClassificationConfig } from "../../src/models/config.js";

describe("ClassificationResolver", () => {
  const rules: ClassificationConfig[] = [
    { level: "restricted", paths: [".env*", "**/*.pem", "**/secrets/**"] },
    { level: "confidential", paths: ["src/backend/auth/**", "**/credentials/**"] },
    { level: "internal", paths: ["src/**"] },
  ];

  it("classifies paths using first matching rule", () => {
    const resolver = new ClassificationResolver(rules);
    expect(resolver.classify(".env.local")).toBe("restricted");
    expect(resolver.classify("src/backend/auth/login.ts")).toBe("confidential");
    expect(resolver.classify("src/ui/button.ts")).toBe("internal");
    expect(resolver.classify("docs/readme.md")).toBe("public");
  });

  it("returns highest classification for a set of files", () => {
    const resolver = new ClassificationResolver(rules);
    const highest = resolver.highestLevel([
      "src/ui/button.ts",
      "src/backend/auth/login.ts",
      "docs/readme.md",
    ]);
    expect(highest).toBe("confidential");
  });

  it("groups files by classification level", () => {
    const resolver = new ClassificationResolver(rules);
    const groups = resolver.classifyMany([
      "docs/readme.md",
      "src/ui/button.ts",
      "src/backend/auth/login.ts",
      ".env.local",
    ]);
    expect(groups).toEqual([
      { level: "restricted", files: [".env.local"] },
      { level: "confidential", files: ["src/backend/auth/login.ts"] },
      { level: "internal", files: ["src/ui/button.ts"] },
      { level: "public", files: ["docs/readme.md"] },
    ]);
  });
});
