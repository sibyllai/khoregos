/**
 * Integration test for audit timestamp command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { sessionToDbRow } from "../../src/models/session.js";
import type { Session } from "../../src/models/session.js";

const createAndStoreTimestampAnchorFromHmacMock = vi.fn(async (params: {
  db: Db;
  sessionId: string;
  eventSequence: number;
  timestamping: { authorityUrl: string };
}) => {
  const anchor = {
    id: "anchor-123",
    sessionId: params.sessionId,
    createdAt: "2026-02-20T12:00:02.000Z",
    chainHash: "deadbeef",
    eventSequence: params.eventSequence,
    tsaResponse: "AAA=",
    tsaUrl: params.timestamping.authorityUrl,
    verified: true,
  };
  params.db.insert("timestamps", {
    id: anchor.id,
    session_id: anchor.sessionId,
    created_at: anchor.createdAt,
    chain_hash: anchor.chainHash,
    event_sequence: anchor.eventSequence,
    tsa_response: anchor.tsaResponse,
    tsa_url: anchor.tsaUrl,
    verified: anchor.verified ? 1 : 0,
  });
  return anchor;
});

vi.mock("../../src/engine/timestamp.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/timestamp.js")>(
    "../../src/engine/timestamp.js",
  );
  return {
    ...actual,
    createAndStoreTimestampAnchorFromHmac: (...args: unknown[]) => createAndStoreTimestampAnchorFromHmacMock(...args),
  };
});

describe("audit timestamp command", () => {
  let projectRoot: string;
  let originalCwd: string;
  let db: Db;

  beforeEach(() => {
    vi.resetModules();
    createAndStoreTimestampAnchorFromHmacMock.mockClear();

    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-audit-timestamp-"));
    const khoregosDir = path.join(projectRoot, ".khoregos");
    mkdirSync(khoregosDir, { recursive: true });
    writeFileSync(path.join(projectRoot, "k6s.yaml"), [
      "version: '1'",
      "project:",
      "  name: test",
      "observability:",
      "  timestamping:",
      "    enabled: true",
      "    authority_url: http://example.test/tsa",
      "    interval_events: 0",
      "",
    ].join("\n"));

    db = new Db(path.join(khoregosDir, "k6s.db"));
    db.connect();
    const session: Session = {
      id: "session-123",
      objective: "timestamp test",
      state: "active",
      startedAt: "2026-02-20T12:00:00.000Z",
      endedAt: null,
      parentSessionId: null,
      configSnapshot: null,
      contextSummary: null,
      metadata: null,
      operator: null,
      hostname: null,
      k6sVersion: null,
      claudeCodeVersion: null,
      gitBranch: null,
      gitSha: null,
      gitDirty: false,
      traceId: "trace-123",
    };
    db.insert("sessions", sessionToDbRow(session));
    db.insert("audit_events", {
      id: "evt-1",
      sequence: 1,
      session_id: "session-123",
      agent_id: null,
      timestamp: "2026-02-20T12:00:01.000Z",
      event_type: "session_start",
      action: "start",
      details: null,
      files_affected: null,
      gate_id: null,
      hmac: "abc123",
      severity: "info",
    });

    process.chdir(projectRoot);
  });

  afterEach(() => {
    db.close();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("stores a timestamp anchor and logs a system event", async () => {
    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(["audit", "timestamp", "--session", "latest"], {
      from: "user",
    });

    expect(createAndStoreTimestampAnchorFromHmacMock).toHaveBeenCalledTimes(1);
    const anchor = db.fetchOne(
      "SELECT * FROM timestamps WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      ["session-123"],
    );
    expect(anchor).toBeDefined();
    expect(anchor?.tsa_url).toBe("http://example.test/tsa");
    expect(anchor?.verified).toBe(1);

    const systemEvent = db.fetchOne(
      `SELECT action FROM audit_events
       WHERE session_id = ? AND event_type = 'system'
       ORDER BY sequence DESC LIMIT 1`,
      ["session-123"],
    ) as { action?: string } | undefined;
    expect(systemEvent?.action).toContain("timestamp anchor: seq 1");
  });

  it("passes strict verification config when configured", async () => {
    writeFileSync(path.join(projectRoot, "ca.pem"), "dummy-ca");
    writeFileSync(path.join(projectRoot, "k6s.yaml"), [
      "version: '1'",
      "project:",
      "  name: test",
      "observability:",
      "  timestamping:",
      "    enabled: true",
      "    authority_url: http://example.test/tsa",
      "    interval_events: 0",
      "    strict_verify: true",
      "    ca_cert_file: ca.pem",
      "",
    ].join("\n"));

    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(["audit", "timestamp", "--session", "latest"], {
      from: "user",
    });

    expect(createAndStoreTimestampAnchorFromHmacMock).toHaveBeenCalledTimes(1);
    expect(createAndStoreTimestampAnchorFromHmacMock.mock.calls[0]?.[0]).toMatchObject({
      timestamping: {
        strictVerify: true,
      },
    });
  });

  it("passes strict mode even when cert paths are absent", async () => {
    writeFileSync(path.join(projectRoot, "k6s.yaml"), [
      "version: '1'",
      "project:",
      "  name: test",
      "observability:",
      "  timestamping:",
      "    enabled: true",
      "    authority_url: http://example.test/tsa",
      "    interval_events: 0",
      "    strict_verify: true",
      "",
    ].join("\n"));

    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(["audit", "timestamp", "--session", "latest"], {
      from: "user",
    });

    expect(createAndStoreTimestampAnchorFromHmacMock).toHaveBeenCalledTimes(1);
    expect(createAndStoreTimestampAnchorFromHmacMock.mock.calls[0]?.[0]).toMatchObject({
      timestamping: {
        strictVerify: true,
      },
    });
  });
});
