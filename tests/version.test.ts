/**
 * Tests for version module: single source of truth from package.json.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

describe("VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("matches the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("follows semver format", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
