/**
 * End-to-end coverage for init preset behavior.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');
const cliEntrypoint = path.join(projectRoot, 'bin', 'k6s.js');
const tempProjects: string[] = [];

function ensureBuiltCli(): void {
  const distCli = path.join(projectRoot, 'dist', 'cli', 'index.js');
  if (existsSync(distCli)) return;
  execFileSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
}

function makeTempProject(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempProjects.push(dir);
  return dir;
}

function runK6s(
  cwd: string,
  args: string[],
  options?: { expectFailure?: boolean },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [cliEntrypoint, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const err = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (!options?.expectFailure) {
      throw error;
    }
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      exitCode: err.status ?? 1,
    };
  }
}

describe('init presets e2e', () => {
  beforeAll(() => {
    ensureBuiltCli();
  });

  afterEach(() => {
    while (tempProjects.length > 0) {
      const dir = tempProjects.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('lists presets and initializes preset config with header comments', () => {
    const appRoot = makeTempProject('k6s-e2e-init-presets-');

    const listText = runK6s(appRoot, ['init', '--list-presets']).stdout;
    expect(listText).toContain('Available presets:');
    expect(listText).toContain('security-strict');
    expect(listText).toContain('compliance-soc2');

    const listJsonRaw = runK6s(appRoot, [
      '--json',
      'init',
      '--list-presets',
    ]).stdout;
    const listJson = JSON.parse(listJsonRaw) as {
      presets: Array<{ name: string; description: string }>;
    };
    expect(listJson.presets).toHaveLength(6);

    runK6s(appRoot, [
      'init',
      '--preset',
      'minimal',
      '--project-name',
      'acme-corp-project',
    ]);
    const generated = readFileSync(path.join(appRoot, 'k6s.yaml'), 'utf-8');
    expect(generated.startsWith('# Khoregos configuration')).toBe(true);
    expect(generated).toContain('# Generated with preset: minimal');
    const parsed = YAML.parse(generated) as { project: { name: string } };
    expect(parsed.project.name).toBe('acme-corp-project');
  });

  it('returns non-zero and guidance for unknown preset', () => {
    const appRoot = makeTempProject('k6s-e2e-init-unknown-');
    const result = runK6s(appRoot, ['init', '--preset', 'not-real'], {
      expectFailure: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown preset: not-real');
    expect(result.stderr).toContain('k6s init --list-presets');
    expect(existsSync(path.join(appRoot, '.khoregos'))).toBe(false);
    expect(existsSync(path.join(appRoot, 'k6s.yaml'))).toBe(false);
  });
});
