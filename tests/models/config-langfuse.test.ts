/**
 * Tests for Langfuse config schema, secret detection, and sanitization.
 */

import { describe, it, expect } from "vitest";
import {
  K6sConfigSchema,
  LangfuseConfigSchema,
  isHardcodedSecret,
  detectHardcodedSecrets,
  sanitizeConfigForStorage,
  resolveSecret,
} from "../../src/models/config.js";

describe("LangfuseConfigSchema", () => {
  it("defaults to disabled with cloud URL", () => {
    const result = LangfuseConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.base_url).toBe("https://cloud.langfuse.com");
    expect(result.flush_at).toBe(15);
    expect(result.flush_interval).toBe(5000);
  });

  it("accepts full configuration", () => {
    const result = LangfuseConfigSchema.parse({
      enabled: true,
      secret_key: "$LANGFUSE_SECRET_KEY",
      public_key: "$LANGFUSE_PUBLIC_KEY",
      base_url: "https://lf.example.com",
      flush_at: 5,
      flush_interval: 2000,
    });
    expect(result.enabled).toBe(true);
    expect(result.secret_key).toBe("$LANGFUSE_SECRET_KEY");
    expect(result.base_url).toBe("https://lf.example.com");
  });

  it("is included in K6sConfigSchema defaults", () => {
    const config = K6sConfigSchema.parse({
      project: { name: "test" },
    });
    expect(config.observability.langfuse).toBeDefined();
    expect(config.observability.langfuse.enabled).toBe(false);
  });
});

describe("resolveSecret", () => {
  it("resolves env var references", () => {
    process.env.K6S_TEST_SECRET = "resolved-value";
    expect(resolveSecret("$K6S_TEST_SECRET")).toBe("resolved-value");
    delete process.env.K6S_TEST_SECRET;
  });

  it("returns undefined for missing env vars", () => {
    expect(resolveSecret("$NONEXISTENT_K6S_VAR_XYZ")).toBeUndefined();
  });

  it("returns literal values as-is", () => {
    expect(resolveSecret("literal-key")).toBe("literal-key");
  });

  it("returns undefined for undefined input", () => {
    expect(resolveSecret(undefined)).toBeUndefined();
  });
});

describe("isHardcodedSecret", () => {
  it("returns true for literal secret values", () => {
    expect(isHardcodedSecret("sk-lf-abc123")).toBe(true);
    expect(isHardcodedSecret("some-api-key")).toBe(true);
  });

  it("returns false for env var references", () => {
    expect(isHardcodedSecret("$LANGFUSE_SECRET_KEY")).toBe(false);
    expect(isHardcodedSecret("$MY_KEY")).toBe(false);
  });

  it("returns false for undefined or redacted values", () => {
    expect(isHardcodedSecret(undefined)).toBe(false);
    expect(isHardcodedSecret("[REDACTED]")).toBe(false);
  });
});

describe("detectHardcodedSecrets", () => {
  const baseConfig = K6sConfigSchema.parse({
    project: { name: "test" },
  });

  it("returns empty array when no secrets are hardcoded", () => {
    const config = {
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        langfuse: {
          ...baseConfig.observability.langfuse,
          enabled: true,
          secret_key: "$LANGFUSE_SECRET_KEY",
          public_key: "$LANGFUSE_PUBLIC_KEY",
        },
        webhooks: [
          { url: "https://example.com", events: [], secret: "$WH_SECRET" },
        ],
      },
    };
    expect(detectHardcodedSecrets(config)).toEqual([]);
  });

  it("detects hardcoded langfuse secret_key", () => {
    const config = {
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        langfuse: {
          ...baseConfig.observability.langfuse,
          enabled: true,
          secret_key: "sk-lf-hardcoded",
          public_key: "$LANGFUSE_PUBLIC_KEY",
        },
      },
    };
    const warnings = detectHardcodedSecrets(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("secret_key");
    expect(warnings[0]).toContain("hardcoded");
  });

  it("detects hardcoded langfuse public_key", () => {
    const config = {
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        langfuse: {
          ...baseConfig.observability.langfuse,
          enabled: true,
          secret_key: "$LANGFUSE_SECRET_KEY",
          public_key: "pk-lf-hardcoded",
        },
      },
    };
    const warnings = detectHardcodedSecrets(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("public_key");
  });

  it("detects hardcoded webhook secrets", () => {
    const config = {
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        webhooks: [
          { url: "https://example.com", events: [], secret: "hardcoded-secret" },
        ],
      },
    };
    const warnings = detectHardcodedSecrets(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("webhooks[0].secret");
  });

  it("skips langfuse check when disabled", () => {
    const config = {
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        langfuse: {
          ...baseConfig.observability.langfuse,
          enabled: false,
          secret_key: "sk-lf-hardcoded",
          public_key: "pk-lf-hardcoded",
        },
      },
    };
    const warnings = detectHardcodedSecrets(config);
    expect(warnings).toEqual([]);
  });
});

describe("sanitizeConfigForStorage", () => {
  it("redacts langfuse keys in stored config", () => {
    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      observability: {
        langfuse: {
          enabled: true,
          secret_key: "$LANGFUSE_SECRET_KEY",
          public_key: "$LANGFUSE_PUBLIC_KEY",
        },
      },
    });
    const sanitized = sanitizeConfigForStorage(config);
    expect(sanitized.observability.langfuse.secret_key).toBe("[REDACTED]");
    expect(sanitized.observability.langfuse.public_key).toBe("[REDACTED]");
    // Original should not be modified.
    expect(config.observability.langfuse.secret_key).toBe("$LANGFUSE_SECRET_KEY");
  });

  it("still redacts webhook secrets", () => {
    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      observability: {
        webhooks: [{ url: "https://x.com", secret: "$SECRET" }],
      },
    });
    const sanitized = sanitizeConfigForStorage(config);
    expect(sanitized.observability.webhooks[0].secret).toBe("[REDACTED]");
  });
});
