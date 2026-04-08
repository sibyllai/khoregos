import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import YAML, { Document, isNode, isSeq } from 'yaml';
import { isPluginInstalled } from '../daemon/manager.js';
import { generateSigningKey } from '../engine/signing.js';
import { generateDefaultConfig } from '../models/config.js';
import { getPreset, listPresets, type PresetMeta } from '../presets/index.js';
import { runAllChecks, printCheckResults } from '../engine/doctor.js';
import { output, outputError, resolveJsonOption } from './output.js';

const PRESET_REFERENCE_URL =
  'https://github.com/sibyllai/khoregos/wiki/Configuration';

function formatPresetLine(name: string, description: string): string {
  return `  ${name.padEnd(19)} ${description}`;
}

export function printPresetList(json: boolean): void {
  const presets = listPresets();
  if (json) {
    output(
      {
        presets: presets.map((preset) => ({
          name: preset.name,
          description: preset.description,
        })),
      },
      { json: true },
    );
    return;
  }

  console.log('Available presets:');
  console.log();
  for (const preset of presets) {
    console.log(formatPresetLine(preset.name, preset.description));
  }
}

export function serializePresetYaml(
  config: unknown,
  preset: PresetMeta,
): string {
  const doc = new Document(config, { sortMapEntries: false });

  doc.commentBefore = [
    ' Khoregos configuration',
    ` Generated with preset: ${preset.name}`,
    ` ${preset.description}`,
    '',
    ' Customize this file for your project.',
    ` Reference: ${PRESET_REFERENCE_URL}`,
    '',
    ...(preset.extraHeaderComments ?? []).map((line) =>
      line.startsWith('#') ? line.slice(1) : ` ${line}`,
    ),
  ].join('\n');

  addInlineComments(doc, preset.name);

  return doc.toString({ lineWidth: 120 });
}

// Attach contextual YAML comments to specific nodes so guidance sits
// right next to the field it refers to.
function addInlineComments(doc: Document, presetName: string): void {
  const strictVerify = doc.getIn(
    ['observability', 'timestamping', 'strict_verify'],
    true,
  );
  if (isNode(strictVerify)) {
    strictVerify.commentBefore =
      ' Set to true once the TSA certificate is installed (requires openssl on PATH).';
  }

  if (presetName === 'compliance-soc2') {
    const webhooks = doc.getIn(['observability', 'webhooks'], true);
    if (webhooks && isSeq(webhooks)) {
      webhooks.commentBefore = [
        ' SIEM webhook stub — uncomment the example below and configure:',
        '   - url: "https://siem.example.com/hooks/khoregos"',
        '     events: ["gate_triggered", "boundary_violation"]',
        '     secret: "$K6S_WEBHOOK_SECRET"',
      ].join('\n');
    }
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Khoregos in the current project')
    .option('-n, --name <name>', 'Project name (defaults to directory name)')
    .option('--project-name <name>', 'Project name override for generated config')
    .option('--preset <name>', 'Use a named preset to generate k6s.yaml')
    .option('--list-presets', 'List available presets and exit')
    .option('-f, --force', 'Overwrite existing configuration')
    .action(
      (
        opts: {
          name?: string;
          projectName?: string;
          preset?: string;
          listPresets?: boolean;
          force?: boolean;
          json?: boolean;
        },
        command: Command,
      ) => {
        const json = resolveJsonOption(opts, command);
        const projectRoot = process.cwd();
        const khoregoDir = path.join(projectRoot, '.khoregos');
        const configFile = path.join(projectRoot, 'k6s.yaml');

        if (opts.listPresets) {
          printPresetList(json);
          return;
        }

        if (existsSync(configFile) && !opts.force) {
          outputError(
            'Project already initialized. Use --force to overwrite.',
            'ALREADY_INITIALIZED',
            { json },
          );
          process.exit(1);
        }

        const projectName =
          opts.projectName ?? opts.name ?? path.basename(projectRoot);

        const selectedPreset = opts.preset ? getPreset(opts.preset) : undefined;
        if (opts.preset && !selectedPreset) {
          outputError(
            `Unknown preset: ${opts.preset}. Run 'k6s init --list-presets' to see options.`,
            'UNKNOWN_PRESET',
            { json },
          );
          process.exit(1);
        }

        mkdirSync(khoregoDir, { recursive: true });
        console.log(chalk.green('✓') + ' Created .khoregos/');

        if (selectedPreset) {
          const config = selectedPreset.factory(projectName);
          const yamlContent = serializePresetYaml(config, selectedPreset);
          writeFileSync(configFile, yamlContent);
        } else {
          const config = generateDefaultConfig(projectName);
          const yaml = YAML.stringify(config, { sortMapEntries: false });
          writeFileSync(configFile, yaml);
        }
        console.log(chalk.green('✓') + ' Created k6s.yaml');

        if (generateSigningKey(khoregoDir)) {
          console.log(chalk.green('✓') + ' Created .khoregos/signing.key');
        }

        const gitignore = path.join(khoregoDir, '.gitignore');
        writeFileSync(
          gitignore,
          [
            '# Khoregos runtime gitignore',
            '#',
            '# The .khoregos/ directory is intentionally versioned. It signals to',
            '# collaborators that this project uses Khoregos governance. Only runtime',
            '# artifacts (database, signing key, daemon state, PID files) are ignored.',
            '# To export governance data for git, use: k6s export --format git',
            '',
            '*.db',
            '*.db-*',
            'daemon.*',
            '*.pid',
            'signing.key',
            '',
          ].join('\n'),
        );
        console.log(chalk.green('✓') + ' Created .khoregos/.gitignore');

        // If the project has a root .gitignore, add a note explaining
        // that .khoregos/ should remain versioned (not ignored).
        const projectGitignore = path.join(projectRoot, '.gitignore');
        if (existsSync(projectGitignore)) {
          const content = readFileSync(projectGitignore, 'utf-8');
          if (!content.includes('.khoregos')) {
            const note = [
              '',
              '# Khoregos: .khoregos/ is versioned intentionally — do not ignore it.',
              '# Runtime artifacts inside it are excluded by .khoregos/.gitignore.',
              '',
            ].join('\n');
            writeFileSync(projectGitignore, content.trimEnd() + '\n' + note);
            console.log(chalk.green('✓') + ' Added .khoregos note to .gitignore');
          }
        }

        const pluginDetected = isPluginInstalled(projectRoot);
        console.log();
        if (pluginDetected) {
          console.log(chalk.green('✓') + ' Khoregos Claude Code plugin detected');
        } else {
          console.log(chalk.yellow('Khoregos Claude Code plugin not detected.'));
          console.log();
          console.log(
            'The plugin provides automatic hook registration, MCP server setup,',
          );
          console.log('and governance instructions for agents.');
          console.log();
          console.log('To install inside Claude Code, run:');
          console.log();
          console.log('  /plugin marketplace add sibyllai/khoregos');
          console.log('  /plugin install khoregos@sibyllai');
          console.log();
          console.log(
            'Or skip plugin install and continue with direct registration fallback.',
          );
        }

        // Run doctor checks to catch native module issues early.
        console.log();
        console.log(chalk.bold('Running environment checks...'));
        const checks = runAllChecks();
        const healthy = printCheckResults(checks);
        if (!healthy) {
          console.log();
          console.log(
            chalk.yellow('⚠ Environment issues detected.') +
              ' Run ' +
              chalk.bold('k6s doctor') +
              ' for details.',
          );
        }

        console.log();
        console.log(chalk.bold.green(`Khoregos initialized for ${projectName}`));
        console.log();
        console.log('Next steps:');
        console.log('  1. Edit k6s.yaml to configure boundaries and audit rules');
        console.log(
          `  2. Run ${chalk.bold('k6s start "your objective"')} to begin a session`,
        );
      },
    );
}
