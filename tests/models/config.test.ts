/**
 * Tests for config model: loadConfig, sanitizeConfigForStorage, resolveWebhookSecret, generateDefaultConfig.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadConfigOrDefault,
  sanitizeConfigForStorage,
  resolveWebhookSecret,
  generateDefaultConfig,
  K6sConfigSchema,
  type K6sConfig,
} from "../../src/models/config.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

describe("config model", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "k6s-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  describe("loadConfig", () => {
    it("parses valid YAML and returns config", () => {
      const yaml = `
version: "1"
project:
  name: my-project
  description: Test project
session:
  audit_retention_days: 90
boundaries:
  - pattern: "*"
    forbidden_paths: [".env*"]
    enforcement: advisory
`;
      const configPath = path.join(tempDir, "k6s.yaml");
      writeFileSync(configPath, yaml);
      const config = loadConfig(configPath);
      expect(config.project.name).toBe("my-project");
      expect(config.session.audit_retention_days).toBe(90);
      expect(config.boundaries).toHaveLength(1);
      expect(config.boundaries![0].pattern).toBe("*");
    });

    it("parses max_tool_calls_per_session in boundary config", () => {
      const yaml = `
version: "1"
project:
  name: my-project
boundaries:
  - pattern: "*"
    forbidden_paths: [".env*"]
    enforcement: advisory
    max_tool_calls_per_session: 5
`;
      const configPath = path.join(tempDir, "k6s.yaml");
      writeFileSync(configPath, yaml);
      const config = loadConfig(configPath);
      expect(config.boundaries).toHaveLength(1);
      expect(config.boundaries[0].max_tool_calls_per_session).toBe(5);
    });

    it("throws on invalid YAML or schema", () => {
      const configPath = path.join(tempDir, "k6s.yaml");
      writeFileSync(configPath, "invalid: yaml: [[[");
      expect(() => loadConfig(configPath)).toThrow();
    });
  });

  describe("loadConfigOrDefault", () => {
    it("returns default config when file missing", () => {
      const config = loadConfigOrDefault(
        path.join(tempDir, "nonexistent.yaml"),
        "default-name",
      );
      expect(config.project.name).toBe("default-name");
      expect(config.boundaries).toBeDefined();
    });

    it("returns loaded config when file exists", () => {
      const configPath = path.join(tempDir, "k6s.yaml");
      writeFileSync(
        configPath,
        "version: '1'\nproject:\n  name: loaded\n",
      );
      const config = loadConfigOrDefault(configPath);
      expect(config.project.name).toBe("loaded");
    });
  });

  describe("sanitizeConfigForStorage", () => {
    it("redacts webhook secrets", () => {
      const config: K6sConfig = K6sConfigSchema.parse({
        project: { name: "p" },
        observability: {
          webhooks: [
            { url: "https://example.com", secret: "s3cr3t", events: [] },
          ],
        },
      });
      const sanitized = sanitizeConfigForStorage(config);
      expect(sanitized.observability?.webhooks?.[0].secret).toBe("[REDACTED]");
      expect(config.observability?.webhooks?.[0].secret).toBe("s3cr3t");
    });
  });

  describe("resolveWebhookSecret", () => {
    it("returns undefined when secret undefined", () => {
      expect(resolveWebhookSecret(undefined)).toBeUndefined();
    });

    it("returns value as-is when not env ref", () => {
      expect(resolveWebhookSecret("literal")).toBe("literal");
    });

    it("resolves env var when secret starts with $", () => {
      process.env.K6S_TEST_SECRET = "from-env";
      expect(resolveWebhookSecret("$K6S_TEST_SECRET")).toBe("from-env");
      delete process.env.K6S_TEST_SECRET;
    });
  });

  describe("generateDefaultConfig", () => {
    it("returns config with project name and default boundaries and gates", () => {
      const config = generateDefaultConfig("my-app");
      expect(config.project.name).toBe("my-app");
      expect(config.boundaries.length).toBeGreaterThanOrEqual(1);
      expect(config.gates.length).toBeGreaterThanOrEqual(1);
      const wildcard = config.boundaries.find((b) => b.pattern === "*");
      expect(wildcard).toBeDefined();
      expect(wildcard!.forbidden_paths).toContain(".env*");
    });
  });
});
