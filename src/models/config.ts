/**
 * Configuration models for k6s.yaml parsing and validation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import YAML from "yaml";

export const ProjectConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export const SessionConfigSchema = z.object({
  context_retention_days: z.number().default(90),
  audit_retention_days: z.number().default(365),
  session_retention_days: z.number().default(365),
  // When true (default), ending a Claude Code session automatically
  // completes the k6s session and removes the daemon state file.
  // Set to false to keep the k6s session alive across multiple
  // Claude Code invocations without requiring an explicit resume.
  end_on_claude_exit: z.boolean().default(true),
});

export const BoundaryConfigSchema = z.object({
  pattern: z.string(),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  enforcement: z.enum(["advisory", "strict"]).default("advisory"),
  max_tool_calls_per_session: z.number().positive().optional(),
});
export type BoundaryConfig = z.infer<typeof BoundaryConfigSchema>;

export const GateTriggerSchema = z.object({
  event_types: z.array(z.string()).optional(),
  file_patterns: z.array(z.string()).optional(),
  custom: z.string().optional(),
});

export const GateConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: GateTriggerSchema,
  approval_mode: z
    .enum(["manual", "auto-approve", "auto-deny"])
    .default("manual"),
  timeout_seconds: z.number().default(1800),
  notify: z.array(z.string()).default(["terminal"]),
});

export const ClassificationLevel = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type ClassificationLevel = z.infer<typeof ClassificationLevel>;

export const ClassificationConfigSchema = z.object({
  level: ClassificationLevel,
  paths: z.array(z.string()),
});
export type ClassificationConfig = z.infer<typeof ClassificationConfigSchema>;

export const PrometheusConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(9090),
});

export const OpenTelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default("http://localhost:4317"),
});

export const TimestampingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  authority_url: z.string().default("https://freetsa.org/tsr"),
  interval_events: z.number().default(0),
  strict_verify: z.boolean().default(false),
  ca_cert_file: z.string().optional(),
  tsa_cert_file: z.string().optional(),
});

export const WebhookConfigSchema = z.object({
  url: z.string(),
  events: z.array(z.string()).default([]),
  // Supports env var references: values starting with "$" are resolved
  // from process.env at runtime (e.g. "$K6S_WEBHOOK_SECRET").
  secret: z.string().optional(),
});

export const LangfuseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // SECURITY: Always use environment variable references ($LANGFUSE_SECRET_KEY).
  // Never hardcode API keys in k6s.yaml — the config file is committed to git.
  secret_key: z.string().optional(),
  public_key: z.string().optional(),
  base_url: z.string().default("https://cloud.langfuse.com"),
  flush_at: z.number().default(15),
  flush_interval: z.number().default(5000),
});
export type LangfuseConfig = z.infer<typeof LangfuseConfigSchema>;

export const ObservabilityConfigSchema = z.object({
  prometheus: PrometheusConfigSchema.default({}),
  opentelemetry: OpenTelemetryConfigSchema.default({}),
  langfuse: LangfuseConfigSchema.default({}),
  timestamping: TimestampingConfigSchema.optional(),
  webhooks: z.array(WebhookConfigSchema).default([]),
});

export const RedactionPatternSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  replacement: z.string().default("[REDACTED]"),
});
export type RedactionPattern = z.infer<typeof RedactionPatternSchema>;

export const TranscriptConfigSchema = z.object({
  store: z.enum(["full", "usage-only", "off"]).default("off"),
  strip_thinking: z.boolean().default(true),
  ner_redaction: z.boolean().default(true),
  max_content_length: z.number().default(50_000),
  redaction_patterns: z.array(RedactionPatternSchema).default([
    { name: "email", pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}", replacement: "[EMAIL]" },
    { name: "phone", pattern: "\\b\\d{3}[\\-.]?\\d{3}[\\-.]?\\d{4}\\b", replacement: "[PHONE]" },
    { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[SSN]" },
    { name: "credit_card", pattern: "\\b\\d{4}[\\- ]?\\d{4}[\\- ]?\\d{4}[\\- ]?\\d{4}\\b", replacement: "[CREDIT_CARD]" },
    { name: "api_key", pattern: "(?:sk|pk|api|key|token|secret|password)[_\\-]?[a-zA-Z0-9]{16,}", replacement: "[API_KEY]" },
  ]),
});
export type TranscriptConfig = z.infer<typeof TranscriptConfigSchema>;

export const PluginConfigSchema = z.object({
  name: z.string(),
  module: z.string(),
  config: z.record(z.unknown()).default({}),
});

export const K6sConfigSchema = z.object({
  version: z.string().default("1"),
  project: ProjectConfigSchema,
  session: SessionConfigSchema.default({}),
  classifications: z.array(ClassificationConfigSchema).default([]),
  boundaries: z.array(BoundaryConfigSchema).default([]),
  gates: z.array(GateConfigSchema).default([]),
  observability: ObservabilityConfigSchema.default({}),
  transcript: TranscriptConfigSchema.default({}),
  plugins: z.array(PluginConfigSchema).default([]),
});
export type K6sConfig = z.infer<typeof K6sConfigSchema>;
export type GateConfig = z.infer<typeof GateConfigSchema>;

export function loadConfig(filePath: string): K6sConfig {
  const raw = readFileSync(filePath, "utf-8");
  const data = YAML.parse(raw);
  return K6sConfigSchema.parse(data);
}

export function loadConfigOrDefault(
  filePath: string,
  projectName = "my-project",
): K6sConfig {
  try {
    return loadConfig(filePath);
  } catch {
    return K6sConfigSchema.parse({ project: { name: projectName } });
  }
}

export function saveConfig(config: K6sConfig, filePath: string): void {
  const yaml = YAML.stringify(config, { sortMapEntries: false });
  writeFileSync(filePath, yaml);
}

/**
 * Resolve a secret value. If it starts with "$", treat it as an
 * environment variable name and return the env value (or undefined).
 */
export function resolveSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  if (secret.startsWith("$")) {
    const envName = secret.slice(1);
    return process.env[envName] ?? undefined;
  }
  return secret;
}

/** @deprecated Use resolveSecret instead. */
export const resolveWebhookSecret = resolveSecret;

/**
 * Check whether a secret value looks like it was hardcoded rather than
 * provided via an environment variable reference ($ENV_VAR).
 */
export function isHardcodedSecret(value: string | undefined): boolean {
  if (!value) return false;
  if (value === "[REDACTED]") return false;
  return !value.startsWith("$");
}

/**
 * Scan the config for hardcoded secrets and return warnings.
 * Call on session start/stop to alert operators about insecure config.
 */
export function detectHardcodedSecrets(config: K6sConfig): string[] {
  const warnings: string[] = [];

  for (let i = 0; i < (config.observability?.webhooks ?? []).length; i++) {
    const wh = config.observability.webhooks[i];
    if (isHardcodedSecret(wh.secret)) {
      warnings.push(
        `observability.webhooks[${i}].secret appears to be hardcoded. Use an environment variable reference (e.g. "$K6S_WEBHOOK_SECRET") instead.`,
      );
    }
  }

  const lf = config.observability?.langfuse;
  if (lf?.enabled) {
    if (isHardcodedSecret(lf.secret_key)) {
      warnings.push(
        `observability.langfuse.secret_key appears to be hardcoded. Use an environment variable reference (e.g. "$LANGFUSE_SECRET_KEY") instead.`,
      );
    }
    if (isHardcodedSecret(lf.public_key)) {
      warnings.push(
        `observability.langfuse.public_key appears to be hardcoded. Use an environment variable reference (e.g. "$LANGFUSE_PUBLIC_KEY") instead.`,
      );
    }
  }

  return warnings;
}

/**
 * Return a deep copy of the config with all secrets redacted.
 * Use this before persisting config snapshots to the database.
 */
export function sanitizeConfigForStorage(config: K6sConfig): K6sConfig {
  const copy = structuredClone(config);
  for (const wh of copy.observability?.webhooks ?? []) {
    if (wh.secret) {
      wh.secret = "[REDACTED]";
    }
  }
  const lf = copy.observability?.langfuse;
  if (lf) {
    if (lf.secret_key) lf.secret_key = "[REDACTED]";
    if (lf.public_key) lf.public_key = "[REDACTED]";
  }
  return copy;
}

export function generateDefaultConfig(projectName: string): K6sConfig {
  return K6sConfigSchema.parse({
    version: "1",
    project: { name: projectName, description: "Project governed by Khoregos" },
    boundaries: [
      {
        pattern: "*",
        forbidden_paths: [".env*", "**/*.pem", "**/*.key"],
        enforcement: "advisory",
      },
    ],
    gates: [
      {
        id: "dependency-approval",
        name: "New Dependency Approval",
        trigger: {
          file_patterns: [
            "package.json",
            "requirements.txt",
            "go.mod",
            "Cargo.toml",
            "**/pom.xml",
          ],
        },
        approval_mode: "manual",
        timeout_seconds: 1800,
        notify: ["terminal"],
      },
      {
        id: "security-files",
        name: "Security File Changes",
        trigger: {
          file_patterns: [
            ".env*",
            "**/auth/**",
            "**/security/**",
            "**/*.pem",
            "**/*.key",
          ],
        },
        approval_mode: "manual",
        notify: ["terminal"],
      },
    ],
  });
}
