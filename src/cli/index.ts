/**
 * Main CLI entry point for Khoregos.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { DaemonState, isPluginInstalled } from '../daemon/manager.js';
import {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  redactEndpointForLogs,
  recordSessionStart,
  recordAuditEvent,
  recordActiveAgentDelta,
  recordBoundaryViolation,
  recordToolDurationSeconds,
  recordTokenUsage,
} from '../engine/telemetry.js';
import {
  generateDefaultConfig,
  K6sConfigSchema,
  loadConfig,
} from '../models/config.js';
import { K6sServer } from '../mcp/server.js';
import { Db } from '../store/db.js';
import { StateManager } from '../engine/state.js';
import { registerTeamCommands } from './team.js';
import { registerSessionCommands } from './session.js';
import { registerAuditCommands } from './audit.js';
import { registerHookCommands } from './hook.js';
import { registerComplianceCommands } from './compliance.js';
import { registerExportCommand } from './export.js';
import { registerCostCommands } from './cost.js';
import { registerInitCommand } from './init.js';
import { registerDashboardCommands } from './dashboard.js';
import { registerDoctorCommand } from './doctor.js';
import { output, outputError, resolveJsonOption } from './output.js';
import { VERSION } from '../version.js';

const program = new Command();

function hasRegisteredHooks(hooks: unknown): boolean {
  if (!hooks) return false;
  if (Array.isArray(hooks)) {
    return hooks.length > 0;
  }
  if (typeof hooks !== 'object') return false;
  const hookGroups = Object.values(hooks as Record<string, unknown>);
  if (hookGroups.length === 0) return false;
  return hookGroups.some((group) => {
    if (!Array.isArray(group) || group.length === 0) return false;
    return group.some((entry) => {
      const nested = (entry as Record<string, unknown>).hooks;
      return Array.isArray(nested) && nested.length > 0;
    });
  });
}

program
  .name('k6s')
  .description(
    'Khoregos: Enterprise governance layer for Claude Code Agent Teams',
  )
  .version(VERSION)
  .option('--json', 'Output in JSON format');

// Subcommands
registerTeamCommands(program);
registerSessionCommands(program);
registerAuditCommands(program);
registerHookCommands(program);
registerComplianceCommands(program);
registerExportCommand(program);
registerCostCommands(program);
registerInitCommand(program);
registerDashboardCommands(program);
registerDoctorCommand(program);

// telemetry smoke
program
  .command('telemetry')
  .description('OpenTelemetry diagnostics')
  .argument('[action]', 'Action: smoke')
  .option('--project-root <path>', 'Project root to load k6s.yaml from')
  .action(async (action?: string, opts?: { projectRoot?: string }) => {
    const cmd = action ?? 'smoke';
    if (cmd === 'smoke') {
      const endpoint = process.env.K6S_OTEL_ENDPOINT ?? 'http://localhost:4318';
      const config = K6sConfigSchema.parse({
        project: { name: 'smoke' },
        observability: {
          opentelemetry: { enabled: true, endpoint },
        },
      });
      initTelemetry(config);
      const tracer = getTracer();
      tracer.startActiveSpan(
        'smoke_test',
        { attributes: { smoke: 'true' } },
        (span) => {
          span.end();
        },
      );
      await shutdownTelemetry();
      const safeEndpoint = redactEndpointForLogs(endpoint);
      console.log(chalk.green('Smoke trace sent.'));
      console.log(chalk.dim(`Endpoint: ${safeEndpoint}`));
      console.log(
        chalk.dim(
          "In Jaeger, select service 'khoregos' and look for span 'smoke_test'.",
        ),
      );
      return;
    }

    if (cmd === 'serve') {
      const projectRoot = opts?.projectRoot ?? process.cwd();
      const configFile = path.join(projectRoot, 'k6s.yaml');
      if (!existsSync(configFile)) {
        console.error(chalk.red(`No k6s.yaml found at ${configFile}.`));
        process.exit(1);
      }
      const config = loadConfig(configFile);
      initTelemetry(config);
      const db = new Db(path.join(projectRoot, '.khoregos', 'k6s.db'));
      db.connect();

      let lastRowId = 0;
      const applyAuditMetrics = (): void => {
        const rows = db.fetchAll(
          `SELECT rowid, sequence, event_type, severity, details
           FROM audit_events
           WHERE rowid > ?
           ORDER BY rowid ASC`,
          [lastRowId],
        );
        for (const row of rows) {
          const rowId = Number(row.rowid ?? 0);
          const sequence = Number(row.sequence ?? 0);
          const eventType = String(row.event_type ?? 'log');
          const severity = String(row.severity ?? 'info');
          const detailsRaw =
            typeof row.details === 'string' ? row.details : null;
          let details: Record<string, unknown> | null = null;
          if (detailsRaw) {
            try {
              details = JSON.parse(detailsRaw) as Record<string, unknown>;
            } catch {
              details = null;
            }
          }

          recordAuditEvent(eventType, severity);
          if (eventType === 'session_start') {
            recordSessionStart();
          } else if (eventType === 'agent_spawn') {
            recordActiveAgentDelta(1);
          } else if (eventType === 'agent_complete') {
            recordActiveAgentDelta(-1);
          } else if (eventType === 'boundary_violation') {
            const violationType =
              (details?.violation_type as string | undefined) ?? 'unknown';
            recordBoundaryViolation(violationType);
          } else if (eventType === 'tool_use') {
            const durationMs = details?.duration_ms;
            if (typeof durationMs === 'number' && durationMs >= 0) {
              recordToolDurationSeconds(durationMs / 1000);
            }
          }

          // Emit token metrics from cost_records linked to this audit event.
          const costRow = db.fetchOne(
            'SELECT input_tokens, output_tokens, estimated_cost_usd, model FROM cost_records WHERE audit_event_id = ?',
            [String(row.id)],
          );
          if (costRow) {
            recordTokenUsage(
              Number(costRow.input_tokens),
              Number(costRow.output_tokens),
              Number(costRow.estimated_cost_usd),
              String(costRow.model ?? 'unknown'),
            );
          }

          if (rowId > lastRowId) {
            lastRowId = rowId;
          }
        }
      };

      applyAuditMetrics();
      const interval = setInterval(() => {
        applyAuditMetrics();
      }, 1000);
      const shutdown = async () => {
        clearInterval(interval);
        db.close();
        await shutdownTelemetry();
        process.exit(0);
      };
      process.on('SIGTERM', () => {
        void shutdown();
      });
      process.on('SIGINT', () => {
        void shutdown();
      });
      return;
    }

    console.error(chalk.red(`Unknown action: ${cmd}. Use 'smoke' or 'serve'.`));
    process.exit(1);
  });

// status
program
  .command('status')
  .description('Show current Khoregos status')
  .option('--json', 'Output in JSON format')
  .action((opts: { json?: boolean }, command: Command) => {
    const json = resolveJsonOption(opts, command);
    const projectRoot = process.cwd();
    const configFile = path.join(projectRoot, 'k6s.yaml');
    const settingsFile = path.join(projectRoot, '.claude', 'settings.json');

    if (!existsSync(configFile)) {
      if (json) {
        outputError('Not initialized. Run k6s init first.', 'NOT_INITIALIZED', { json: true });
      } else {
      console.log(
        chalk.yellow('Not initialized.') +
          ' Run ' +
          chalk.bold('k6s init') +
          ' first.',
      );
      }
      process.exit(1);
    }

    let mcpRegistered = false;
    let hooksRegistered = false;
    if (isPluginInstalled(projectRoot)) {
      mcpRegistered = true;
      hooksRegistered = true;
    } else if (existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        mcpRegistered = Boolean(mcpServers?.khoregos);
        hooksRegistered = hasRegisteredHooks(settings.hooks);
      } catch {
        mcpRegistered = false;
        hooksRegistered = false;
      }
    }

    const daemon = new DaemonState(path.join(projectRoot, '.khoregos'));
    const daemonRunning = daemon.isRunning();
    if (json) {
      let activeSession: Record<string, unknown> | null = null;
      if (daemonRunning) {
        const state = daemon.readState();
        const sessionId = (state.session_id as string) ?? 'unknown';
        if (existsSync(path.join(projectRoot, '.khoregos', 'k6s.db'))) {
          const db = new Db(path.join(projectRoot, '.khoregos', 'k6s.db'));
          db.connect();
          try {
            const sm = new StateManager(db, projectRoot);
            const session = sm.getSession(sessionId);
            activeSession = {
              session_id: session?.id ?? sessionId,
              objective: session?.objective ?? null,
              state: session?.state ?? 'active',
              started_at: session?.startedAt ?? null,
              operator: session?.operator ?? null,
              git_branch: session?.gitBranch ?? null,
              trace_id: session?.traceId ?? null,
            };
          } finally {
            db.close();
          }
        } else {
          activeSession = {
            session_id: sessionId,
            objective: null,
            state: 'active',
            started_at: null,
            operator: null,
            git_branch: null,
            trace_id: null,
          };
        }
      }

      output(
        {
          active_session: activeSession,
          daemon_running: daemonRunning,
          mcp_registered: mcpRegistered,
          hooks_registered: hooksRegistered,
        },
        { json: true },
      );
      return;
    }

    console.log(`${chalk.bold('Project:')} ${path.basename(projectRoot)}`);
    console.log(`${chalk.bold('Config:')} ${configFile}`);

    if (daemonRunning) {
      const state = daemon.readState();
      const sessionId = (state.session_id as string) ?? 'unknown';
      console.log(`${chalk.bold('Status:')} ${chalk.green('Active')}`);
      console.log(`${chalk.bold('Session:')} ${sessionId}`);
    } else {
      console.log(`${chalk.bold('Status:')} ${chalk.dim('Inactive')}`);
    }
  });

// mcp serve
program
  .command('mcp')
  .description('MCP server commands')
  .argument('<action>', 'Action: serve')
  .option('--project-root <path>', 'Project root to serve from')
  .action((action: string, opts: { projectRoot?: string }) => {
    if (action === 'serve') {
      runMcpServer(opts.projectRoot);
    } else {
      console.error(chalk.red(`Unknown action: ${action}`));
      process.exit(1);
    }
  });

function runMcpServer(projectRootArg?: string): void {
  const projectRoot = projectRootArg ?? process.cwd();
  const configFile = path.join(projectRoot, 'k6s.yaml');

  let config;
  if (existsSync(configFile)) {
    config = loadConfig(configFile);
  } else {
    config = generateDefaultConfig(path.basename(projectRoot));
  }

  let sessionId = process.env.K6S_SESSION_ID;
  if (!sessionId) {
    const daemon = new DaemonState(path.join(projectRoot, '.khoregos'));
    const state = daemon.readState();
    sessionId = (state.session_id as string) ?? 'default';
  }

  initTelemetry(config);
  if (sessionId !== 'default') {
    recordSessionStart();
  }

  const db = new Db(path.join(projectRoot, '.khoregos', 'k6s.db'));
  db.connect();

  const server = new K6sServer(db, config, sessionId, projectRoot);
  server
    .runStdio()
    .then(async () => {
      await shutdownTelemetry();
      db.close();
    })
    .catch(async (err) => {
      console.error('MCP server error:', err);
      await shutdownTelemetry();
      db.close();
      process.exit(1);
    });
}

program.parse();
