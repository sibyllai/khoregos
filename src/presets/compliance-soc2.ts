import { K6sConfigSchema, type K6sConfig } from '../models/config.js';

export function createComplianceSoc2Config(projectName: string): K6sConfig {
  return K6sConfigSchema.parse({
    version: '1',
    project: {
      name: projectName,
      description: 'SOC 2 oriented controls and evidence generation.',
    },
    session: {
      context_retention_days: 365,
      audit_retention_days: 365,
      session_retention_days: 365,
      end_on_claude_exit: false,
    },
    boundaries: [
      {
        pattern: '*',
        forbidden_paths: [
          '.env*',
          '**/*.pem',
          '**/*.key',
          '**/secrets/**',
          '.khoregos/signing.key',
        ],
        enforcement: 'advisory',
        max_tool_calls_per_session: 200,
      },
    ],
    gates: [
      {
        id: 'dependency-approval',
        name: 'Dependency and lockfile changes',
        trigger: {
          file_patterns: [
            'package.json',
            'pnpm-lock.yaml',
            'package-lock.json',
            'yarn.lock',
            'requirements.txt',
            'poetry.lock',
            'go.mod',
            'go.sum',
            'Cargo.toml',
            'Cargo.lock',
            '**/pom.xml',
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
          file_patterns: [
            '.env*',
            '**/auth/**',
            '**/security/**',
            '**/secrets/**',
            '**/*.pem',
            '**/*.key',
          ],
        },
        approval_mode: 'manual',
        timeout_seconds: 1800,
        notify: ['terminal'],
      },
      {
        id: 'infrastructure-files',
        name: 'Infrastructure and deployment changes',
        trigger: {
          file_patterns: [
            '**/.github/workflows/**',
            '**/docker-compose*.yml',
            '**/docker-compose*.yaml',
            '**/Dockerfile*',
            '**/k8s/**',
            '**/kubernetes/**',
            '**/helm/**',
            '**/terraform/**',
            '**/*.tf',
            '**/*.tfvars',
          ],
        },
        approval_mode: 'manual',
        timeout_seconds: 1800,
        notify: ['terminal'],
      },
      {
        id: 'config-files',
        name: 'Governance and config changes',
        trigger: {
          file_patterns: ['k6s.yaml', '.claude/**', '.mcp.json'],
        },
        approval_mode: 'manual',
        timeout_seconds: 1800,
        notify: ['terminal'],
      },
    ],
    classifications: [
      {
        level: 'confidential',
        paths: ['**/auth/**', '**/security/**', '**/secrets/**', '.env*'],
      },
      {
        level: 'restricted',
        paths: ['**/*.pem', '**/*.key', '.khoregos/signing.key'],
      },
    ],
    observability: {
      prometheus: { enabled: false, port: 9090 },
      opentelemetry: { enabled: false, endpoint: 'http://localhost:4317' },
      timestamping: {
        enabled: true,
        authority_url: 'https://freetsa.org/tsr',
        interval_events: 200,
        strict_verify: false,
      },
      webhooks: [],
    },
    plugins: [],
  });
}
