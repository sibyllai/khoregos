import { describe, expect, it } from 'vitest';
import { K6sConfigSchema } from '../../src/models/config.js';
import { getPreset, listPresets } from '../../src/presets/index.js';

describe('presets', () => {
  it('lists all six presets with descriptions', () => {
    const presets = listPresets();
    expect(presets).toHaveLength(6);
    expect(presets.map((preset) => preset.name)).toEqual([
      'minimal',
      'security-strict',
      'compliance-soc2',
      'compliance-iso27001',
      'monorepo',
      'microservices',
    ]);
    for (const preset of presets) {
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('generates schema-valid config for every preset', () => {
    for (const preset of listPresets()) {
      const config = preset.factory('preset-test');
      expect(K6sConfigSchema.safeParse(config).success).toBe(true);
      expect(config.version).toBe('1');
      expect(config.project.name).toBe('preset-test');
    }
  });

  it('security-strict uses strict enforcement on all boundaries', () => {
    const preset = getPreset('security-strict');
    expect(preset).toBeDefined();
    const config = preset!.factory('strict-test');
    expect(config.boundaries.length).toBeGreaterThan(0);
    for (const boundary of config.boundaries) {
      expect(boundary.enforcement).toBe('strict');
    }
  });

  it('compliance presets enable timestamping and long retention', () => {
    for (const name of ['compliance-soc2', 'compliance-iso27001']) {
      const preset = getPreset(name);
      expect(preset).toBeDefined();
      const config = preset!.factory('compliance-test');
      expect(config.observability.timestamping?.enabled).toBe(true);
      expect(config.session.audit_retention_days).toBeGreaterThanOrEqual(365);
      expect(config.session.session_retention_days).toBeGreaterThanOrEqual(365);
    }
  });

  it('monorepo and microservices include shared paths in boundaries', () => {
    const monorepoConfig = getPreset('monorepo')!.factory('mono');
    const microservicesConfig = getPreset('microservices')!.factory('micro');

    const monorepoAllowed = monorepoConfig.boundaries.flatMap(
      (boundary) => boundary.allowed_paths,
    );
    const microservicesAllowed = microservicesConfig.boundaries.flatMap(
      (boundary) => boundary.allowed_paths,
    );

    expect(monorepoAllowed).toContain('packages/shared-types/**');
    expect(microservicesAllowed).toContain('shared/types/**');
  });
});
