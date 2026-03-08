import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";
import { Db } from "../../src/store/db.js";
import { K6sConfigSchema } from "../../src/models/config.js";
import { DashboardServer } from "../../src/engine/dashboard.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { loadSigningKey } from "../../src/engine/signing.js";
import path from "node:path";
import { mkdirSync } from "node:fs";

function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers as Record<string, string>,
        });
      });
    }).on("error", reject);
  });
}

function httpPost(url: string, data: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("DashboardServer", () => {
  let db: Db;
  let server: DashboardServer;
  let port: number;
  let sessionId: string;
  let projectRoot: string;

  beforeAll(async () => {
    const dbPath = getTempDbPath();
    projectRoot = path.dirname(dbPath);
    const khoregoDir = projectRoot;
    mkdirSync(khoregoDir, { recursive: true });

    db = new Db(dbPath);
    db.connect();

    const config = K6sConfigSchema.parse({ project: { name: "test-dashboard" } });
    const sm = new StateManager(db, projectRoot);
    const session = sm.createSession({ objective: "dashboard test" });
    sessionId = session.id;

    // Write a few audit events.
    const key = loadSigningKey(khoregoDir);
    const logger = new AuditLogger(db, sessionId, session.traceId, key);
    logger.start();
    logger.log({ eventType: "session_start", action: "session started: dashboard test" });
    logger.log({ eventType: "tool_use", action: "tool_use: Read", severity: "info" });
    logger.log({ eventType: "boundary_violation", action: "strict enforcement: reverted foo.js", severity: "critical" });
    logger.stop();

    server = new DashboardServer({ db, config, sessionId, port: 0, host: "127.0.0.1" });
    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    db.close();
    cleanupTempDir();
  });

  it("serves HTML at /", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Khoregos");
    expect(res.body).toContain(sessionId.slice(0, 8));
  });

  it("returns events via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/events?limit=10`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.events).toBeDefined();
    expect(data.events.length).toBeGreaterThanOrEqual(3);
    expect(data.events[0].event_type).toBe("session_start");
  });

  it("returns sessions via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns cost via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/cost`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.summary).toBeDefined();
    expect(data.summary.total_cost).toBeDefined();
  });

  it("returns agents via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/agents`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.agents).toBeDefined();
  });

  it("returns review items via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/review`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toBeDefined();
    // Should include the boundary_violation event.
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  it("returns transcript entries via REST API", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/transcript`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it("accepts role filter on transcript endpoint", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/transcript?role=user&limit=10`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.entries).toBeDefined();
  });

  it("rejects POST /api/push without valid token", async () => {
    const res = await httpPost(
      `http://127.0.0.1:${port}/api/push`,
      JSON.stringify({ id: "no-auth", event_type: "test", action: "no auth" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/push with wrong token", async () => {
    const res = await httpPost(
      `http://127.0.0.1:${port}/api/push`,
      JSON.stringify({ id: "bad-auth", event_type: "test", action: "bad auth" }),
      { Authorization: "Bearer wrong-token" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts POST /api/push with valid token and broadcasts via SSE", async () => {
    const authHeaders = { Authorization: `Bearer ${server.pushToken}` };

    // Connect SSE first.
    const sseEvents: string[] = [];
    const ssePromise = new Promise<void>((resolve) => {
      http.get(`http://127.0.0.1:${port}/events`, (res) => {
        res.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (text.includes('"event_type":"test_push"')) {
            sseEvents.push(text);
            res.destroy();
            resolve();
          }
        });
      });
    });

    // Give SSE time to connect.
    await new Promise((r) => setTimeout(r, 50));

    // Push an event with valid token.
    const pushRes = await httpPost(
      `http://127.0.0.1:${port}/api/push`,
      JSON.stringify({ id: "push-test-001", event_type: "test_push", action: "push test" }),
      authHeaders,
    );
    expect(pushRes.status).toBe(200);

    // Wait for SSE to receive it.
    await ssePromise;
    expect(sseEvents.length).toBe(1);
    expect(sseEvents[0]).toContain("test_push");
  });

  it("deduplicates pushed events", async () => {
    const authHeaders = { Authorization: `Bearer ${server.pushToken}` };
    const eventId = "dedup-test-001";
    const event = { id: eventId, event_type: "test_dedup", action: "dedup" };

    // Push the same event twice.
    await httpPost(`http://127.0.0.1:${port}/api/push`, JSON.stringify(event), authHeaders);
    await httpPost(`http://127.0.0.1:${port}/api/push`, JSON.stringify(event), authHeaders);

    // No crash, and the server's seen set should contain it.
    const res = await httpPost(`http://127.0.0.1:${port}/api/push`, JSON.stringify(event), authHeaders);
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("does not include wildcard CORS headers", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/events`);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses to bind to 0.0.0.0", async () => {
    const config = K6sConfigSchema.parse({ project: { name: "test" } });
    const dangerousServer = new DashboardServer({
      db, config, sessionId, port: 0, host: "0.0.0.0",
    });
    await expect(dangerousServer.start()).rejects.toThrow("Refusing to bind");
  });

  it("refuses to bind to ::", async () => {
    const config = K6sConfigSchema.parse({ project: { name: "test" } });
    const dangerousServer = new DashboardServer({
      db, config, sessionId, port: 0, host: "::",
    });
    await expect(dangerousServer.start()).rejects.toThrow("Refusing to bind");
  });
});
