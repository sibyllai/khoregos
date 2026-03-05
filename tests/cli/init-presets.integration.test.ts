import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { registerInitCommand } from '../../src/cli/init.js';
import { generateDefaultConfig } from '../../src/models/config.js';

describe('init command presets', () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), 'k6s-init-cli-'));
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function createProgram(): Command {
    const program = new Command().option('--json');
    registerInitCommand(program);
    return program;
  }

  it('lists all presets in text mode', async () => {
    const program = createProgram();
    await program.parseAsync(['init', '--list-presets'], { from: 'user' });
    const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(output).toContain('Available presets:');
    expect(output).toContain('minimal');
    expect(output).toContain('security-strict');
    expect(output).toContain('compliance-soc2');
    expect(output).toContain('compliance-iso27001');
    expect(output).toContain('monorepo');
    expect(output).toContain('microservices');
  });

  it('lists all presets in JSON mode', async () => {
    const program = createProgram();
    await program.parseAsync(['--json', 'init', '--list-presets'], {
      from: 'user',
    });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0])) as {
      presets: Array<{ name: string; description: string }>;
    };
    expect(payload.presets).toHaveLength(6);
    expect(payload.presets[0].name).toBe('minimal');
  });

  it('initializes with selected preset and project-name override', async () => {
    const program = createProgram();
    await program.parseAsync(
      ['init', '--preset', 'minimal', '--project-name', 'icrc-pearl'],
      { from: 'user' },
    );

    const rawYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    expect(rawYaml.startsWith('# Khoregos configuration')).toBe(true);
    expect(rawYaml).toContain('# Generated with preset: minimal');
    const parsed = YAML.parse(rawYaml) as { project: { name: string } };
    expect(parsed.project.name).toBe('icrc-pearl');
  });

  it('security-strict preset config has strict boundaries', async () => {
    const program = createProgram();
    await program.parseAsync(['init', '--preset', 'security-strict'], {
      from: 'user',
    });

    const rawYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    const parsed = YAML.parse(rawYaml) as {
      boundaries: Array<{ enforcement: string }>;
    };
    expect(parsed.boundaries.length).toBeGreaterThan(0);
    for (const boundary of parsed.boundaries) {
      expect(boundary.enforcement).toBe('strict');
    }
  });

  it('unknown preset exits with helpful error message', async () => {
    const program = createProgram();
    await expect(
      program.parseAsync(['init', '--preset', 'unknown-preset'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run 'k6s init --list-presets'"),
    );
    expect(existsSync(path.join(projectRoot, '.khoregos'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'k6s.yaml'))).toBe(false);
  });

  it('default init remains backward compatible when no preset is provided', async () => {
    const program = createProgram();
    await program.parseAsync(['init', '--name', 'compat-default'], {
      from: 'user',
    });
    const rawYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    expect(rawYaml.startsWith('# Khoregos configuration')).toBe(false);

    const parsed = YAML.parse(rawYaml);
    const expected = generateDefaultConfig('compat-default');
    expect(parsed).toEqual(expected);
  });

  it('monorepo and microservices presets include customization comments', async () => {
    const monorepoProgram = createProgram();
    await monorepoProgram.parseAsync(['init', '--preset', 'monorepo'], {
      from: 'user',
    });
    const monoYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    expect(monoYaml).toContain('IMPORTANT: Customize both boundary patterns AND allowed paths');

    rmSync(path.join(projectRoot, 'k6s.yaml'), { force: true });
    mkdirSync(path.join(projectRoot, '.khoregos'), { recursive: true });
    const microservicesProgram = createProgram();
    await microservicesProgram.parseAsync(['init', '--preset', 'microservices', '--force'], {
      from: 'user',
    });
    const microYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    expect(microYaml).toContain('IMPORTANT: Customize both boundary patterns AND allowed paths');
  });

  it('compliance-soc2 preset includes inline SIEM webhook stub comment', async () => {
    const program = createProgram();
    await program.parseAsync(['init', '--preset', 'compliance-soc2'], {
      from: 'user',
    });
    const rawYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
    expect(rawYaml).toContain('SIEM webhook stub');
    expect(rawYaml).toContain('siem.example.com');
    expect(rawYaml).toContain('K6S_WEBHOOK_SECRET');
  });

  it('compliance presets include strict_verify guidance comment', async () => {
    for (const presetName of ['compliance-soc2', 'compliance-iso27001']) {
      const program = createProgram();
      await program.parseAsync(['init', '--preset', presetName, '--force'], {
        from: 'user',
      });
      const rawYaml = readFileSync(path.join(projectRoot, 'k6s.yaml'), 'utf-8');
      expect(rawYaml).toContain('Set to true once the TSA certificate is installed');
    }
  });
});
