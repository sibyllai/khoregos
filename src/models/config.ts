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
});

export const BoundaryConfigSchema = z.object({
  pattern: z.string(),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  enforcement: z.enum(["advisory", "strict"]).default("advisory"),
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

export const PrometheusConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(9090),
});

export const OpenTelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default("http://localhost:4317"),
});

export const WebhookConfigSchema = z.object({
  url: z.string(),
  events: z.array(z.string()).default([]),
  secret: z.string().optional(),
});

export const ObservabilityConfigSchema = z.object({
  prometheus: PrometheusConfigSchema.default({}),
  opentelemetry: OpenTelemetryConfigSchema.default({}),
  webhooks: z.array(WebhookConfigSchema).default([]),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  module: z.string(),
  config: z.record(z.unknown()).default({}),
});

export const K6sConfigSchema = z.object({
  version: z.string().default("1"),
  project: ProjectConfigSchema,
  session: SessionConfigSchema.default({}),
  boundaries: z.array(BoundaryConfigSchema).default([]),
  gates: z.array(GateConfigSchema).default([]),
  observability: ObservabilityConfigSchema.default({}),
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
