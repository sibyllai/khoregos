import type { K6sConfig } from '../models/config.js';
import { createComplianceIso27001Config } from './compliance-iso27001.js';
import { createComplianceSoc2Config } from './compliance-soc2.js';
import { createMicroservicesConfig } from './microservices.js';
import { createMinimalConfig } from './minimal.js';
import { createMonorepoConfig } from './monorepo.js';
import { createSecurityStrictConfig } from './security-strict.js';

export interface PresetMeta {
  name: string;
  description: string;
  factory: (projectName: string) => K6sConfig;
  extraHeaderComments?: string[];
}

export const PRESETS: Record<string, PresetMeta> = {
  minimal: {
    name: 'minimal',
    description: 'Bare minimum governance. Audit trail only, no boundaries.',
    factory: createMinimalConfig,
  },
  'security-strict': {
    name: 'security-strict',
    description:
      'Strict enforcement on secrets and sensitive paths. Git-backed revert.',
    factory: createSecurityStrictConfig,
  },
  'compliance-soc2': {
    name: 'compliance-soc2',
    description:
      'SOC 2-aligned config with audit retention, gates, and reporting.',
    factory: createComplianceSoc2Config,
  },
  'compliance-iso27001': {
    name: 'compliance-iso27001',
    description:
      'ISO 27001-aligned config with data classification and timestamping.',
    factory: createComplianceIso27001Config,
  },
  monorepo: {
    name: 'monorepo',
    description: 'Boundaries for a multi-package monorepo structure.',
    factory: createMonorepoConfig,
    extraHeaderComments: [
      '# IMPORTANT: Customize both boundary patterns AND allowed paths.',
      '# The "pattern" field matches agent names (e.g. auth-*, payments-*).',
      '# The "allowed_paths" field restricts which files that agent can touch.',
      '# Replace packages/auth, packages/payments, apps/web, and shared-types',
      '# with the package/app names used by your monorepo.',
      '#',
    ],
  },
  microservices: {
    name: 'microservices',
    description: 'Per-service boundaries for a microservices architecture.',
    factory: createMicroservicesConfig,
    extraHeaderComments: [
      '# IMPORTANT: Customize both boundary patterns AND allowed paths.',
      '# The "pattern" field matches agent names (e.g. auth-*, gateway-*).',
      '# The "allowed_paths" field restricts which files that agent can touch.',
      '# Replace services/auth, services/payments, services/gateway, and',
      '# shared/types with your actual service and shared module paths.',
      '#',
    ],
  },
};

export function getPreset(name: string): PresetMeta | undefined {
  return PRESETS[name];
}

export function listPresets(): PresetMeta[] {
  return Object.values(PRESETS);
}
