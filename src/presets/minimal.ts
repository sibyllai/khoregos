import { K6sConfigSchema, type K6sConfig } from '../models/config.js';

export function createMinimalConfig(projectName: string): K6sConfig {
  return K6sConfigSchema.parse({
    version: '1',
    project: {
      name: projectName,
      description: 'Minimal governance preset for fast iteration.',
    },
    session: {
      context_retention_days: 30,
      audit_retention_days: 30,
      session_retention_days: 30,
      end_on_claude_exit: true,
    },
    boundaries: [
      {
        pattern: '*',
        forbidden_paths: ['.env*'],
        enforcement: 'advisory',
      },
    ],
    gates: [],
    observability: {
      prometheus: { enabled: false, port: 9090 },
      opentelemetry: { enabled: false, endpoint: 'http://localhost:4317' },
      webhooks: [],
    },
    plugins: [],
  });
}
