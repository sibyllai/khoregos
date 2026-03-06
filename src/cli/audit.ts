/**
 * Audit trail CLI commands.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { AuditLogger, pruneAuditEvents, pruneSessions } from "../engine/audit.js";
import { loadSigningKey, verifyChain, type VerifyError } from "../engine/signing.js";
import { generateAuditReport, type ReportStandard } from "../engine/report.js";
import { displayEventType } from "../engine/event-types.js";
import {
  createAndStoreTimestampAnchorFromHmac,
  type TimestampAnchor,
} from "../engine/timestamp.js";
import { loadConfigOrDefault } from "../models/config.js";
import type {
  AuditEvent,
  AuditSeverity,
  EventType,
} from "../models/audit.js";
import { withDb, resolveSessionId } from "./shared.js";
import { output, outputError, resolveJsonOption } from "./output.js";
import {
  queryTranscript,
  countTranscriptEntries,
} from "../engine/transcript-store.js";

function parseDuration(duration: string): string {
  const value = parseInt(duration.slice(0, -1), 10);
  const unit = duration.slice(-1);
  const now = Date.now();

  let ms: number;
  switch (unit) {
    case "h":
      ms = value * 3600 * 1000;
      break;
    case "m":
      ms = value * 60 * 1000;
      break;
    case "d":
      ms = value * 86400 * 1000;
      break;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
  return new Date(now - ms).toISOString();
}

/** Format a millisecond delta as a human-readable short string. */
function formatDeltaMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function printEvent(event: AuditEvent): void {
  const agent = event.agentId ? event.agentId.slice(0, 8) : "system";
  const typeColor: Record<string, (s: string) => string> = {
    file_create: chalk.green,
    file_modify: chalk.yellow,
    file_delete: chalk.red,
    session_start: chalk.blue,
    session_complete: chalk.blue,
    sensitive_needs_review: chalk.magenta,
  };
  const displayType = displayEventType(event.eventType);
  const colorFn = typeColor[displayType] ?? chalk.white;
  const time = new Date(event.timestamp).toTimeString().slice(0, 8);

  console.log(
    `${chalk.dim(time)} ${chalk.cyan(agent.padStart(10))} ${colorFn(displayType.padEnd(15))} ${event.action}`,
  );
}

function parseReportStandard(value: string): ReportStandard {
  if (value === "generic" || value === "soc2" || value === "iso27001") {
    return value;
  }
  throw new Error("standard must be one of: generic, soc2, iso27001");
}

function normalizeExportEvents(raw: unknown): AuditEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((event): event is AuditEvent => {
    if (!event || typeof event !== "object") return false;
    const e = event as Record<string, unknown>;
    return typeof e.sessionId === "string"
      && typeof e.sequence === "number"
      && typeof e.timestamp === "string"
      && typeof e.eventType === "string"
      && typeof e.action === "string";
  });
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    return [];
  }
  return [];
}

type VerifyJsonErrorEntry =
  | { type: "gap"; missing_sequences: number[] }
  | { type: "missing_hmac"; event_id: string | null; sequence: number }
  | {
      type: "mismatch";
      event_id: string | null;
      sequence: number;
      expected_hmac: string | null;
      stored_hmac: string | null;
    };

function mapVerifyErrors(
  verification: { errors: VerifyError[] },
  events: AuditEvent[],
): {
  gaps: number;
  missingHmacs: number;
  mismatches: number;
  errors: VerifyJsonErrorEntry[];
} {
  const eventBySeq = new Map<number, AuditEvent>(events.map((event) => [event.sequence, event]));
  const gaps = verification.errors.filter((error) => error.type === "gap");
  const missing = verification.errors.filter((error) => error.type === "missing");
  const mismatches = verification.errors.filter((error) => error.type === "mismatch");

  const errors = verification.errors.map((error) => {
    if (error.type === "gap") {
      const match = /expected (\d+), got (\d+)/.test(error.message)
        ? error.message.match(/expected (\d+), got (\d+)/)
        : null;
      const expected = match ? Number(match[1]) : null;
      const got = match ? Number(match[2]) : error.sequence;
      const missingSequences: number[] = [];
      if (expected !== null && Number.isFinite(expected) && got > expected) {
        for (let seq = expected; seq < got; seq += 1) {
          missingSequences.push(seq);
        }
      }
      return {
        type: "gap",
        missing_sequences: missingSequences,
      } as VerifyJsonErrorEntry;
    }

    const event = eventBySeq.get(error.sequence);
    if (error.type === "missing") {
      return {
        type: "missing_hmac",
        event_id: event?.id ?? null,
        sequence: error.sequence,
      } as VerifyJsonErrorEntry;
    }

    return {
      type: "mismatch",
      event_id: event?.id ?? null,
      sequence: error.sequence,
      expected_hmac: error.expected ?? null,
      stored_hmac: error.actual ?? null,
    } as VerifyJsonErrorEntry;
  });

  return {
    gaps: gaps.length,
    missingHmacs: missing.length,
    mismatches: mismatches.length,
    errors,
  };
}

function toVerifyJson(
  verification: { valid: boolean; eventsChecked: number; errors: VerifyError[] },
  sessionId: string,
  events: AuditEvent[],
): {
  source: "sqlite";
  session_id: string;
  result: "CHAIN_INTACT" | "CHAIN_BROKEN";
  total_events: number;
  valid: number;
  gaps: number;
  missing_hmacs: number;
  mismatches: number;
  errors: VerifyJsonErrorEntry[];
} {
  const mapped = mapVerifyErrors(verification, events);
  const totalFaults = mapped.gaps + mapped.missingHmacs + mapped.mismatches;
  return {
    source: "sqlite",
    session_id: sessionId,
    result: verification.valid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
    total_events: verification.eventsChecked,
    valid: Math.max(0, verification.eventsChecked - totalFaults),
    gaps: mapped.gaps,
    missing_hmacs: mapped.missingHmacs,
    mismatches: mapped.mismatches,
    errors: mapped.errors,
  };
}

export function registerAuditCommands(program: Command): void {
  const audit = program.command("audit").description("View audit trail");

  audit
    .command("timestamp")
    .description("Create an external timestamp anchor for a session")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .action(async (opts: { session: string }) => {
      try {
        const projectRoot = process.cwd();
        const khoregoDir = path.join(projectRoot, ".khoregos");
        if (!existsSync(path.join(khoregoDir, "k6s.db"))) {
          console.log(chalk.yellow("No audit data found."));
          return;
        }

        const config = loadConfigOrDefault(path.join(projectRoot, "k6s.yaml"), "project");
        const timestampingConfig = config.observability?.timestamping;
        const tsaUrl = timestampingConfig?.authority_url ?? "https://freetsa.org/tsr";
        const strictVerify = timestampingConfig?.strict_verify === true;

        const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
        db.connect();
        let anchor: TimestampAnchor | null = null;
        try {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) {
            console.log(chalk.yellow("No session found."));
            return;
          }

          const latest = db.fetchOne(
            "SELECT sequence, hmac FROM audit_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
            [sessionId],
          );
          const sequence = Number(latest?.sequence ?? 0);
          const hmac = typeof latest?.hmac === "string" ? latest.hmac : null;
          if (!hmac || sequence <= 0) {
            console.log(chalk.yellow("No signed audit events available for timestamping."));
            return;
          }

          const caCertFile = timestampingConfig?.ca_cert_file
            ? (
              path.isAbsolute(timestampingConfig.ca_cert_file)
                ? timestampingConfig.ca_cert_file
                : path.join(projectRoot, timestampingConfig.ca_cert_file)
            )
            : undefined;
          const tsaCertFile = timestampingConfig?.tsa_cert_file
            ? (
              path.isAbsolute(timestampingConfig.tsa_cert_file)
                ? timestampingConfig.tsa_cert_file
                : path.join(projectRoot, timestampingConfig.tsa_cert_file)
            )
            : undefined;

          anchor = await createAndStoreTimestampAnchorFromHmac({
            db,
            sessionId,
            eventSequence: sequence,
            eventHmac: hmac,
            timestamping: {
              authorityUrl: tsaUrl,
              strictVerify,
              caCertFile,
              tsaCertFile,
            },
            projectRoot,
          });

          const key = loadSigningKey(khoregoDir);
          const session = sm.getSession(sessionId);
          const logger = new AuditLogger(db, sessionId, session?.traceId, key);
          logger.start();
          let host = tsaUrl;
          try {
            host = new URL(tsaUrl).host;
          } catch {
            host = tsaUrl;
          }
          logger.log({
            eventType: "system",
            action: `timestamp anchor: seq ${sequence}, tsa=${host}`,
            details: {
              anchor_id: anchor.id,
              chain_hash: anchor.chainHash,
              event_sequence: sequence,
              tsa_url: tsaUrl,
              verified: anchor.verified,
              strict_verified: strictVerify,
            },
            severity: "info",
          });
          logger.stop();
        } finally {
          db.close();
        }

        if (!anchor) {
          return;
        }
        console.log(
          chalk.green("✓")
          + ` Timestamp anchor created at seq ${anchor.eventSequence} (${anchor.verified ? "verified" : "unverified"})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "timestamp anchor failed";
        console.error(chalk.red(`Error: ${message}.`));
        process.exit(1);
      }
    });

  audit
    .command("show")
    .description("Show audit trail events")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-a, --agent <name>", "Filter by agent name")
    .option("-t, --type <type>", "Filter by event type")
    .option(
      "--severity <level>",
      "Filter by severity (info, warning, critical)",
    )
    .option("--since <duration>", "Show events since (e.g., '1h', '30m')")
    .option("--trace-id <id>", "Filter by trace/correlation ID")
    .option("-n, --limit <number>", "Maximum events to show", "50")
    .option("--json", "Output in JSON format")
    .action(
      (opts: {
        session: string;
        agent?: string;
        type?: string;
        severity?: string;
        since?: string;
        traceId?: string;
        limit: string;
        json?: boolean;
      },
      command: Command) => {
        const json = resolveJsonOption(opts, command);
        const filtersApplied = {
          session_id: opts.session === "latest" ? null : opts.session,
          agent: opts.agent ?? null,
          type: opts.type ?? null,
          severity: opts.severity ?? null,
          since: opts.since ?? null,
          trace_id: opts.traceId ?? null,
          limit: parseInt(opts.limit, 10),
        };
        const emptyPayload = { events: [], total_count: 0, filters_applied: filtersApplied };
        const projectRoot = process.cwd();
        if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
          if (json) {
            output(emptyPayload, { json: true });
            return;
          }
          console.log(chalk.yellow("No audit data found."));
          return;
        }

        const result = withDb(projectRoot, (db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) return null;

          const al = new AuditLogger(db, sessionId);
          let events = al.getEvents({
            limit: parseInt(opts.limit, 10),
            eventType: opts.type as EventType | undefined,
            since: opts.since ? parseDuration(opts.since) : undefined,
            severity: opts.severity as AuditSeverity | undefined,
            traceId: opts.traceId,
          });

          // Build agent ID -> name map for display and JSON metadata.
          const agents = sm.listAgents(sessionId);
          const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
          if (opts.agent) {
            const normalizedFilter = opts.agent.toLowerCase();
            events = events.filter((event) => {
              const name = event.agentId ? (agentNameById.get(event.agentId) ?? "") : "";
              return name.toLowerCase() === normalizedFilter;
            });
          }

          const session = sm.getSession(sessionId);
          return { events, sessionId, agentNameById, traceId: session?.traceId };
        });

        if (json) {
          if (!result) {
            output(emptyPayload, { json: true });
            return;
          }
          output(
            {
              events: result.events.map((event) => ({
                id: event.id,
                sequence: event.sequence,
                session_id: event.sessionId,
                agent_id: event.agentId,
                agent_name: event.agentId ? (result.agentNameById.get(event.agentId) ?? null) : null,
                timestamp: event.timestamp,
                event_type: event.eventType,
                action: event.action,
                severity: event.severity,
                files_affected: parseStringArray(event.filesAffected),
                details: parseJsonObject(event.details),
              })),
              total_count: result.events.length,
              filters_applied: {
                ...filtersApplied,
                session_id: result.sessionId,
                trace_id: opts.traceId ?? result.traceId ?? null,
              },
            },
            { json: true },
          );
          return;
        }

        if (!result || !result.events.length) {
          console.log(chalk.dim("No events found."));
          return;
        }

        console.log(`${chalk.bold("Session:")} ${result.sessionId.slice(0, 8)}...`);
        if (result.traceId) {
          console.log(`${chalk.bold("Trace ID:")} ${result.traceId}`);
        }
        console.log();

        const table = new Table({
          head: ["Time", "Seq", "Delta", "Agent", "Sev", "Type", "Action"],
        });

        // Compute delta (time since previous event) in sequence order.
        // Events arrive DESC; reverse for ascending computation.
        const ascending = [...result.events].reverse();
        const deltaBySeq = new Map<number, string>();
        for (let i = 0; i < ascending.length; i++) {
          if (i === 0) {
            deltaBySeq.set(ascending[i].sequence, "—");
          } else {
            const prev = new Date(ascending[i - 1].timestamp).getTime();
            const curr = new Date(ascending[i].timestamp).getTime();
            const ms = curr - prev;
            deltaBySeq.set(ascending[i].sequence, formatDeltaMs(ms));
          }
        }

        const severityColor: Record<string, (s: string) => string> = {
          critical: chalk.red,
          warning: chalk.yellow,
          info: chalk.dim,
        };
        for (const event of result.events) {
          const sev = event.severity ?? "info";
          const colorFn = severityColor[sev] ?? chalk.dim;
          const agentLabel = event.agentId
            ? result.agentNameById.get(event.agentId) ?? event.agentId.slice(0, 8) + "..."
            : "system";
          table.push([
            new Date(event.timestamp).toTimeString().slice(0, 8),
            String(event.sequence),
            chalk.dim(deltaBySeq.get(event.sequence) ?? "—"),
            agentLabel,
            colorFn(sev.slice(0, 4)),
            displayEventType(event.eventType),
            event.action.length > 45
              ? event.action.slice(0, 45) + "..."
              : event.action,
          ]);
        }

        console.log(table.toString());
      },
    );

  audit
    .command("tail")
    .description("Live stream audit events")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("--no-follow", "Don't follow new events")
    .action((opts: { session: string; follow: boolean }) => {
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      console.log(chalk.dim("Streaming audit events (Ctrl+C to stop)..."));
      console.log();

      let lastSequence = 0;

      const db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
      db.connect();

      try {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) {
          console.log(chalk.yellow("No session found."));
          return;
        }

        const al = new AuditLogger(db, sessionId);

        // Show recent events first
        const events = al.getEvents({ limit: 10 });
        for (const event of [...events].reverse()) {
          printEvent(event);
          lastSequence = Math.max(lastSequence, event.sequence);
        }

        if (!opts.follow) return;

        // Poll for new events
        const interval = setInterval(() => {
          const newEvents = al.getEvents({ limit: 100 });
          const fresh = newEvents.filter((e) => e.sequence > lastSequence);
          for (const event of [...fresh].reverse()) {
            printEvent(event);
            lastSequence = Math.max(lastSequence, event.sequence);
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(interval);
          console.log(chalk.dim("\nStopped."));
          db.close();
          process.exit(0);
        });
      } catch {
        db.close();
      }
    });

  audit
    .command("export")
    .description("Export audit trail")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-f, --format <format>", "Output format: json, csv", "json")
    .option("--trace-id <id>", "Filter by trace/correlation ID")
    .option("-o, --output <file>", "Output file (stdout if not specified)")
    .action(
      (opts: { session: string; format: string; traceId?: string; output?: string }) => {
        const projectRoot = process.cwd();
        if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
          console.error(chalk.yellow("No audit data found."));
          return;
        }

        const events = withDb(projectRoot, (db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) return [];

          const al = new AuditLogger(db, sessionId);
          return al.getEvents({ limit: 10000, traceId: opts.traceId });
        });

        let output: string;

        if (opts.format === "json") {
          output = JSON.stringify(events, null, 2);
        } else if (opts.format === "csv") {
          const header =
            "timestamp,sequence,session_id,agent_id,severity,event_type,action,files_affected";
          const rows = events.map((e) => {
            const files = e.filesAffected
              ? JSON.parse(e.filesAffected).join(";")
              : "";
            return [
              e.timestamp,
              e.sequence,
              e.sessionId,
              e.agentId ?? "",
              e.severity ?? "info",
              displayEventType(e.eventType),
              `"${e.action.replace(/"/g, '""')}"`,
              files,
            ].join(",");
          });
          output = [header, ...rows].join("\n");
        } else {
          console.error(chalk.red(`Unknown format: ${opts.format}`));
          process.exit(1);
        }

        if (opts.output) {
          writeFileSync(opts.output, output);
          console.log(
            chalk.green("✓") +
              ` Exported ${events.length} events to ${opts.output}`,
          );
        } else {
          console.log(output);
        }
      },
    );

  // -- Prune old audit data.
  audit
    .command("prune")
    .description("Delete audit events older than the retention period")
    .option(
      "--before <date>",
      "Delete events before this ISO date (overrides retention config)",
    )
    .option(
      "--sessions-before <date>",
      "Delete completed sessions with ended_at before this ISO date",
    )
    .option("--dry-run", "Show what would be deleted without deleting")
    .action((opts: { before?: string; sessionsBefore?: string; dryRun?: boolean }) => {
      const projectRoot = process.cwd();
      const configFile = path.join(projectRoot, "k6s.yaml");
      const config = loadConfigOrDefault(configFile, "project");

      const shouldPruneEvents = opts.before !== undefined || opts.sessionsBefore === undefined;
      const shouldPruneSessions = opts.sessionsBefore !== undefined || opts.before === undefined;

      let eventsBeforeDate: string;
      if (opts.before !== undefined) {
        eventsBeforeDate = new Date(opts.before).toISOString();
      } else {
        const retentionDays = config.session.audit_retention_days;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        eventsBeforeDate = cutoff.toISOString();
      }

      let sessionsBeforeDate: string;
      if (opts.sessionsBefore !== undefined) {
        sessionsBeforeDate = new Date(opts.sessionsBefore).toISOString();
      } else {
        const retentionDays = config.session.session_retention_days;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        sessionsBeforeDate = cutoff.toISOString();
      }

      const result = withDb(projectRoot, (db) => {
        const eventsResult = shouldPruneEvents
          ? pruneAuditEvents(db, eventsBeforeDate, opts.dryRun ?? false)
          : { eventsDeleted: 0, sessionsPruned: 0 };
        const sessionsResult = shouldPruneSessions
          ? pruneSessions(db, sessionsBeforeDate, opts.dryRun ?? false)
          : { sessionsPruned: 0 };
        return {
          eventsDeleted: eventsResult.eventsDeleted,
          sessionsPruned: sessionsResult.sessionsPruned,
        };
      });

      if (opts.dryRun) {
        console.log(chalk.dim("Dry run — no data deleted."));
        console.log(
          `  Events that would be deleted: ${chalk.bold(String(result.eventsDeleted))}`,
        );
        console.log(
          `  Sessions that would be pruned: ${chalk.bold(String(result.sessionsPruned))}`,
        );
      } else {
        console.log(
          chalk.green("✓") +
            ` Pruned ${result.eventsDeleted} events, ${result.sessionsPruned} sessions`,
        );
      }
    });

  // -- Verify HMAC chain integrity.
  audit
    .command("verify")
    .description("Verify audit trail HMAC chain integrity")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("--from-export <dir>", "Verify exported session directory instead of SQLite")
    .option("--strict", "Re-verify exported chain from raw events")
    .option("--signing-key <path>", "Signing key path for strict export verification")
    .option("--json", "Output verification result as JSON")
    .option("--exit-code", "Exit with status 1 when verification fails")
    .action((opts: {
      session: string;
      fromExport?: string;
      strict?: boolean;
      signingKey?: string;
      json?: boolean;
      exitCode?: boolean;
    },
    command: Command) => {
      const json = resolveJsonOption(opts, command);
      const projectRoot = process.cwd();
      const khoregoDir = path.join(projectRoot, ".khoregos");

      if (opts.fromExport) {
        const exportDir = path.resolve(projectRoot, opts.fromExport);
        const sessionFile = path.join(exportDir, "session.json");
        const auditFile = path.join(exportDir, "audit-trail.json");
        if (!existsSync(sessionFile) || !existsSync(auditFile)) {
          outputError("Export directory is missing session.json or audit-trail.json.", "EXPORT_MISSING_FILES", { json });
          process.exit(1);
        }

        let sessionData: Record<string, unknown>;
        let exportEvents: AuditEvent[];
        try {
          sessionData = JSON.parse(readFileSync(sessionFile, "utf-8")) as Record<string, unknown>;
          exportEvents = normalizeExportEvents(
            JSON.parse(readFileSync(auditFile, "utf-8")) as unknown,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to parse export files";
          outputError(`Error: ${message}.`, "EXPORT_PARSE_ERROR", { json });
          process.exit(1);
        }

        const sessionId = typeof sessionData.id === "string"
          ? sessionData.id
          : (typeof sessionData.session_id === "string" ? sessionData.session_id : "unknown");
        const chainIntegrity = typeof sessionData.chain_integrity === "string"
          ? sessionData.chain_integrity
          : "CHAIN_UNVERIFIED";
        const attestedValid = chainIntegrity === "CHAIN_INTACT";

        let strictResult:
          | { valid: boolean; eventsChecked: number; errors: VerifyError[] }
          | null = null;
        if (opts.strict) {
          const signingKeyPath = opts.signingKey ?? process.env.K6S_SIGNING_KEY;
          if (!signingKeyPath) {
            outputError(
              "Strict verification requires --signing-key <path> or K6S_SIGNING_KEY.",
              "SIGNING_KEY_REQUIRED",
              { json },
            );
            process.exit(1);
          }
          const resolvedKeyPath = path.resolve(projectRoot, signingKeyPath);
          if (!existsSync(resolvedKeyPath)) {
            outputError(`Signing key not found: ${resolvedKeyPath}.`, "SIGNING_KEY_NOT_FOUND", { json });
            process.exit(1);
          }
          const keyHex = readFileSync(resolvedKeyPath, "utf-8").trim();
          const signingKey = Buffer.from(keyHex, "hex");
          const verification = verifyChain(signingKey, sessionId, exportEvents);
          strictResult = {
            valid: verification.valid,
            eventsChecked: verification.eventsChecked,
            errors: verification.errors,
          };
        }

        const finalValid = strictResult ? strictResult.valid : attestedValid;
        if (json) {
          const verification = strictResult ?? {
            valid: finalValid,
            eventsChecked: exportEvents.length,
            errors: [] as VerifyError[],
          };
          const mapped = mapVerifyErrors(verification, exportEvents);
          const totalFaults = mapped.gaps + mapped.missingHmacs + mapped.mismatches;

          output(
            {
              source: "export",
              session_id: sessionId,
              result: finalValid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
              chain_integrity: chainIntegrity,
              attested_valid: attestedValid,
              strict_checked: Boolean(strictResult),
              strict_valid: strictResult?.valid ?? null,
              total_events: verification.eventsChecked,
              valid: Math.max(0, verification.eventsChecked - totalFaults),
              gaps: mapped.gaps,
              missing_hmacs: mapped.missingHmacs,
              mismatches: mapped.mismatches,
              errors: mapped.errors,
            },
            { json: true },
          );
        } else {
          console.log(`${chalk.bold("Source:")} export`);
          console.log(`${chalk.bold("Session:")} ${sessionId}`);
          console.log(`${chalk.bold("Attested chain:")} ${chainIntegrity}`);
          if (strictResult) {
            console.log(`${chalk.bold("Strict re-verify:")} ${strictResult.valid ? "valid" : "invalid"}`);
            console.log(`${chalk.bold("Events checked:")} ${strictResult.eventsChecked}`);
            console.log(`${chalk.bold("Errors:")} ${strictResult.errors.length}`);
          }
          console.log(
            `${chalk.bold("Result:")} ${finalValid ? chalk.green("valid") : chalk.red("invalid")}`,
          );
        }

        if (opts.exitCode && !finalValid) {
          process.exit(1);
        }
        return;
      }

      if (!existsSync(path.join(khoregoDir, "k6s.db"))) {
        if (json) {
          outputError("No audit data found.", "NO_AUDIT_DATA", { json: true });
        } else {
        console.log(chalk.yellow("No audit data found."));
        }
        return;
      }

      const key = loadSigningKey(khoregoDir);
      if (!key) {
        if (json) {
          outputError("No signing key found. Run k6s init to generate one.", "SIGNING_KEY_NOT_FOUND", { json: true });
          return;
        }
        console.log(
          chalk.yellow("No signing key found.") +
            " Run " +
            chalk.bold("k6s init") +
            " to generate one.",
        );
        return;
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;

        // Fetch all events in sequence order (ascending).
        const events = db
          .fetchAll(
            "SELECT * FROM audit_events WHERE session_id = ? ORDER BY sequence ASC",
            [sessionId],
          )
          .map((row) => ({
            id: row.id as string,
            sequence: row.sequence as number,
            sessionId: row.session_id as string,
            agentId: (row.agent_id as string) ?? null,
            timestamp: row.timestamp as string,
            eventType: row.event_type as string,
            action: row.action as string,
            details: (row.details as string) ?? null,
            filesAffected: (row.files_affected as string) ?? null,
            gateId: (row.gate_id as string) ?? null,
            hmac: (row.hmac as string) ?? null,
            severity: ((row.severity as string) ?? "info") as AuditSeverity,
          })) as AuditEvent[];

        return { sessionId, events, verification: verifyChain(key, sessionId, events) };
      });

      if (!result) {
        if (json) {
          outputError("No session found.", "SESSION_NOT_FOUND", { json: true });
          process.exit(1);
        }
        console.log(chalk.yellow("No session found."));
        return;
      }

      const { sessionId, events, verification } = result;
      if (json) {
        output(toVerifyJson(verification, sessionId, events), { json: true });
      } else if (verification.valid) {
        console.log(`${chalk.bold("Session:")} ${sessionId.slice(0, 8)}...`);
        console.log(
          `${chalk.bold("Events checked:")} ${verification.eventsChecked}`,
        );
        console.log();
        console.log(chalk.green("✓ Audit chain integrity verified."));
      } else {
        console.log(`${chalk.bold("Session:")} ${sessionId.slice(0, 8)}...`);
        console.log(
          `${chalk.bold("Events checked:")} ${verification.eventsChecked}`,
        );
        console.log();
        console.log(
          chalk.red(`✗ ${verification.errors.length} issue(s) found:`),
        );
        console.log();
        for (const err of verification.errors) {
          const prefix =
            err.type === "mismatch"
              ? chalk.red("BROKEN")
              : err.type === "gap"
                ? chalk.yellow("GAP")
                : chalk.yellow("UNSIGNED");
          console.log(`  ${prefix} seq ${err.sequence}: ${err.message}`);
        }
      }

      if (opts.exitCode && !verification.valid) {
        process.exit(1);
      }
    });

  audit
    .command("report")
    .description("Generate a structured audit report for a session")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option(
      "--standard <name>",
      "Report standard: generic, soc2, iso27001",
      "generic",
    )
    .option("-o, --output <file>", "Write report to file (stdout if omitted)")
    .option("--json", "Output in JSON format")
    .action((opts: { session: string; standard: string; output?: string; json?: boolean }, command: Command) => {
      const json = resolveJsonOption(opts, command);
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        if (json) {
          outputError("No audit data found.", "NO_AUDIT_DATA", { json: true });
          process.exit(1);
        }
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      let standard: ReportStandard;
      try {
        standard = parseReportStandard(opts.standard);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid report standard";
        outputError(`Error: ${message}.`, "INVALID_STANDARD", { json });
        process.exit(1);
      }
      const report = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;
        if (!json) {
          return generateAuditReport(db, sessionId, projectRoot, standard);
        }

        const session = sm.getSession(sessionId);
        if (!session) return null;
        const agents = sm.listAgents(sessionId);
        const logger = new AuditLogger(db, sessionId);
        const eventsDesc = logger.getEvents({ limit: 100000 });
        const events = [...eventsDesc].reverse();

        const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
        const verification = signingKey
          ? verifyChain(signingKey, sessionId, events)
          : { valid: false, eventsChecked: events.length, errors: [] as VerifyError[] };
        const byType: Record<string, number> = {};
        const bySeverity: Record<string, number> = {};
        const filesModified = new Set<string>();
        for (const event of events) {
          byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
          bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
          for (const filePath of parseStringArray(event.filesAffected)) {
            filesModified.add(filePath);
          }
        }

        const boundaryRows = db.fetchAll(
          "SELECT id, agent_id, file_path, violation_type, enforcement_action, timestamp FROM boundary_violations WHERE session_id = ? ORDER BY timestamp ASC",
          [sessionId],
        );
        const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
        const gateRows = db.fetchAll(
          "SELECT id, gate_id, action, details, timestamp FROM audit_events WHERE session_id = ? AND event_type = 'gate_triggered' ORDER BY sequence ASC",
          [sessionId],
        );

        return {
          session: {
            id: session.id,
            objective: session.objective,
            operator: session.operator,
            hostname: session.hostname,
            git_branch: session.gitBranch,
            git_sha: session.gitSha,
            started_at: session.startedAt,
            ended_at: session.endedAt,
            duration_seconds: session.endedAt
              ? Math.max(
                  0,
                  Math.floor((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000),
                )
              : null,
            trace_id: session.traceId,
            k6s_version: session.k6sVersion,
          },
          agents: agents.map((agent) => ({
            name: agent.name,
            role: agent.role,
            state: agent.state,
            spawned_at: agent.spawnedAt,
          })),
          chain_integrity: {
            result: verification.valid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
            total_events: verification.eventsChecked,
            valid: Math.max(0, verification.eventsChecked - verification.errors.length),
            gaps: verification.errors.filter((error) => error.type === "gap").length,
            mismatches: verification.errors.filter((error) => error.type === "mismatch").length,
          },
          events_summary: {
            by_type: byType,
            by_severity: bySeverity,
          },
          files_modified: [...filesModified].sort((a, b) => a.localeCompare(b)),
          boundary_violations: boundaryRows.map((row) => ({
            id: row.id,
            agent_name: row.agent_id ? (agentNameById.get(String(row.agent_id)) ?? null) : null,
            file_path: row.file_path,
            violation_type: row.violation_type,
            enforcement_action: row.enforcement_action,
            timestamp: row.timestamp,
          })),
          gate_events: gateRows.map((row) => {
            const details = parseJsonObject((row.details as string) ?? null);
            return {
              id: row.id,
              gate_id: row.gate_id,
              gate_name: typeof details.rule_name === "string" ? details.rule_name : null,
              file_path: typeof details.file === "string" ? details.file : null,
              timestamp: row.timestamp,
            };
          }),
        };
      });

      if (!report) {
        if (json) {
          outputError("No session found.", "SESSION_NOT_FOUND", { json: true });
          process.exit(1);
        }
        console.log(chalk.yellow("No session found."));
        return;
      }

      if (json) {
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(report, null, 2));
          console.log(chalk.green("✓") + ` Wrote audit report to ${opts.output}`);
        } else {
          output(report, { json: true });
        }
        return;
      }

      const markdownReport = report as string;
      if (opts.output) {
        writeFileSync(opts.output, markdownReport);
        console.log(chalk.green("✓") + ` Wrote audit report to ${opts.output}`);
      } else {
        console.log(markdownReport);
      }
    });

  // -- Transcript viewer.
  audit
    .command("transcript")
    .description("View stored conversation transcript entries")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-r, --role <role>", "Filter by role (user, assistant)")
    .option("-n, --limit <number>", "Maximum entries to show", "50")
    .option("--offset <number>", "Skip first N entries", "0")
    .option("--json", "Output in JSON format")
    .action(
      (opts: {
        session: string;
        role?: string;
        limit: string;
        offset: string;
        json?: boolean;
      },
      command: Command) => {
        const json = resolveJsonOption(opts, command);
        const projectRoot = process.cwd();
        if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
          if (json) {
            output({ entries: [], total_count: 0 }, { json: true });
          } else {
            console.log(chalk.yellow("No audit data found."));
          }
          return;
        }

        const result = withDb(projectRoot, (db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) return null;

          const limit = parseInt(opts.limit, 10);
          const offset = parseInt(opts.offset, 10);
          const entries = queryTranscript(db, sessionId, {
            limit,
            offset,
            role: opts.role,
          });
          const totalCount = countTranscriptEntries(db, sessionId);
          return { sessionId, entries, totalCount };
        });

        if (json) {
          if (!result) {
            output({ entries: [], total_count: 0 }, { json: true });
            return;
          }
          output(
            {
              session_id: result.sessionId,
              entries: result.entries.map((e) => ({
                id: e.id,
                sequence: e.sequence,
                entry_type: e.entryType,
                role: e.role,
                model: e.model,
                content: e.content,
                input_tokens: e.inputTokens,
                output_tokens: e.outputTokens,
                cache_creation_input_tokens: e.cacheCreationInputTokens,
                cache_read_input_tokens: e.cacheReadInputTokens,
                timestamp: e.timestamp,
                redacted: e.redacted,
              })),
              total_count: result.totalCount,
            },
            { json: true },
          );
          return;
        }

        if (!result || result.entries.length === 0) {
          console.log(chalk.dim("No transcript entries found."));
          console.log(chalk.dim("Set transcript.store to 'full' or 'usage-only' in k6s.yaml to enable."));
          return;
        }

        console.log(`${chalk.bold("Session:")} ${result.sessionId.slice(0, 8)}...`);
        console.log(`${chalk.bold("Entries:")} ${result.totalCount} total`);
        console.log();

        const table = new Table({
          head: ["Seq", "Time", "Role", "Model", "Tokens", "Content Preview"],
          colWidths: [6, 10, 10, 20, 12, 50],
          wordWrap: true,
        });

        for (const entry of result.entries) {
          const tokens = entry.inputTokens != null
            ? `${entry.inputTokens}/${entry.outputTokens ?? 0}`
            : "—";
          const contentPreview = entry.content
            ? entry.content.slice(0, 80).replace(/\n/g, " ")
            : chalk.dim("(usage-only)");
          const roleColor = entry.role === "user" ? chalk.cyan : chalk.green;
          table.push([
            String(entry.sequence),
            new Date(entry.timestamp).toTimeString().slice(0, 8),
            roleColor(entry.role ?? "—"),
            entry.model ?? "—",
            tokens,
            contentPreview + (entry.redacted ? chalk.red(" [R]") : ""),
          ]);
        }

        console.log(table.toString());
      },
    );
}
