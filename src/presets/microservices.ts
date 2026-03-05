import { K6sConfigSchema, type K6sConfig } from '../models/config.js';

export function createMicroservicesConfig(projectName: string): K6sConfig {
  return K6sConfigSchema.parse({
    version: '1',
    project: {
      name: projectName,
      description: 'Microservices boundary template for service-level isolation.',
    },
    session: {
      context_retention_days: 90,
      audit_retention_days: 365,
      session_retention_days: 365,
      end_on_claude_exit: true,
    },
    boundaries: [
      {
        pattern: 'auth-*',
        allowed_paths: ['services/auth/**', 'shared/types/**'],
        forbidden_paths: ['.env*', '**/*.pem', '**/*.key'],
        enforcement: 'advisory',
      },
      {
        pattern: 'payments-*',
        allowed_paths: ['services/payments/**', 'shared/types/**'],
        forbidden_paths: ['.env*', '**/*.pem', '**/*.key'],
        enforcement: 'advisory',
      },
      {
        pattern: 'gateway-*',
        allowed_paths: ['services/gateway/**', 'shared/types/**'],
        forbidden_paths: ['.env*', '**/*.pem', '**/*.key'],
        enforcement: 'advisory',
      },
      {
        pattern: '*',
        forbidden_paths: ['.env*', '**/*.pem', '**/*.key', '.khoregos/signing.key'],
        enforcement: 'advisory',
      },
    ],
    gates: [
      {
        id: 'dependency-approval',
        name: 'Dependency and lockfile changes',
        trigger: {
          file_patterns: [
            '**/package.json',
            'pnpm-lock.yaml',
            'package-lock.json',
            'yarn.lock',
            '**/requirements.txt',
            '**/go.mod',
            '**/Cargo.toml',
          ],
        },
        approval_mode: 'manual',
        timeout_seconds: 1800,
        notify: ['terminal'],
      },
      {
        id: 'security-files',
        name: 'Security-sensitive file changes',
        trigger: {
          file_patterns: ['.env*', '**/auth/**', '**/security/**', '**/*.pem', '**/*.key'],
        },
        approval_mode: 'manual',
        timeout_seconds: 1800,
        notify: ['terminal'],
      },
    ],
    observability: {
      prometheus: { enabled: false, port: 9090 },
      opentelemetry: { enabled: false, endpoint: 'http://localhost:4317' },
      webhooks: [],
    },
    plugins: [],
  });
}
