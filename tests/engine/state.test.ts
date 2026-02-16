/**
 * Tests for StateManager: sessions, agents, context.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("StateManager", () => {
  let db: Db;
  let state: StateManager;
  const projectRoot = "/tmp/k6s-state-test";

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
    state = new StateManager(db, projectRoot);
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  describe("sessions", () => {
    it("createSession returns session with id and traceId", () => {
      const session = state.createSession({
        objective: "state test objective",
      });
      expect(session.id).toBeDefined();
      expect(session.state).toBe("created");
      expect(session.traceId).toBeDefined();
      expect(session.objective).toBe("state test objective");
    });

    it("getSession returns null for unknown id", () => {
      expect(state.getSession("nonexistent")).toBeNull();
    });

    it("getSession returns session by id", () => {
      const created = state.createSession({ objective: "get test" });
      const found = state.getSession(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.objective).toBe("get test");
    });

    it("getLatestSession returns most recent by started_at", () => {
      const first = state.createSession({ objective: "latest 1" });
      const second = state.createSession({ objective: "latest 2" });
      first.startedAt = new Date(Date.now() - 60_000).toISOString();
      state.updateSession(first);
      const latest = state.getLatestSession();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(second.id);
      expect(latest!.objective).toBe("latest 2");
    });

    it("getActiveSession returns session in created or active state", () => {
      const created = state.createSession({ objective: "active test" });
      const active = state.getActiveSession();
      expect(active).not.toBeNull();
      expect(active!.id).toBe(created.id);
    });

    it("listSessions returns sessions with default limit", () => {
      const list = state.listSessions({ limit: 5 });
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeLessThanOrEqual(5);
    });

    it("listSessions filters by state when provided", () => {
      const list = state.listSessions({ state: "created", limit: 10 });
      list.forEach((s) => expect(s.state).toBe("created"));
    });

    it("updateSession persists changes", () => {
      const session = state.createSession({ objective: "update test" });
      session.state = "active";
      state.updateSession(session);
      const found = state.getSession(session.id);
      expect(found!.state).toBe("active");
    });

    it("markSessionActive updates state", () => {
      const session = state.createSession({ objective: "mark active" });
      state.markSessionActive(session.id);
      const found = state.getSession(session.id);
      expect(found!.state).toBe("active");
    });

    it("markSessionCompleted sets ended_at and state", () => {
      const session = state.createSession({ objective: "complete test" });
      state.markSessionCompleted(session.id, "Done.");
      const found = state.getSession(session.id);
      expect(found!.state).toBe("completed");
      expect(found!.endedAt).not.toBeNull();
      expect(found!.contextSummary).toBe("Done.");
    });
  });

  describe("agents", () => {
    let sessionId: string;

    beforeAll(() => {
      const session = state.createSession({ objective: "agent test" });
      sessionId = session.id;
    });

    it("registerAgent returns agent with id", () => {
      const agent = state.registerAgent({
        sessionId,
        name: "primary",
        role: "lead",
      });
      expect(agent.id).toBeDefined();
      expect(agent.name).toBe("primary");
      expect(agent.role).toBe("lead");
      expect(agent.state).toBe("active");
    });

    it("getAgent returns null for unknown id", () => {
      expect(state.getAgent("nonexistent")).toBeNull();
    });

    it("getAgentByName returns agent", () => {
      state.registerAgent({ sessionId, name: "worker-1" });
      const a = state.getAgentByName(sessionId, "worker-1");
      expect(a).not.toBeNull();
      expect(a!.name).toBe("worker-1");
    });

    it("getAgentByClaudeSessionId returns agent after assign", () => {
      const agent = state.registerAgent({ sessionId, name: "correlate" });
      state.updateAgent({ ...agent, claudeSessionId: "claude-sess-1" });
      const found = state.getAgentByClaudeSessionId(sessionId, "claude-sess-1");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("correlate");
    });

    it("assignClaudeSessionToNewestUnassignedAgent assigns and returns agent", () => {
      const agent = state.registerAgent({ sessionId, name: "unassigned" });
      const assigned = state.assignClaudeSessionToNewestUnassignedAgent(
        sessionId,
        "claude-sess-2",
      );
      expect(assigned).not.toBeNull();
      const found = state.getAgent(assigned!.id);
      expect(found!.claudeSessionId).toBe("claude-sess-2");
    });

    it("listAgents returns agents for session", () => {
      const agents = state.listAgents(sessionId);
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("context", () => {
    let sessionId: string;

    beforeAll(() => {
      const session = state.createSession({ objective: "context test" });
      sessionId = session.id;
    });

    it("saveContext and loadContext roundtrip", () => {
      state.saveContext({
        sessionId,
        key: "test-key",
        value: "test-value",
      });
      const entry = state.loadContext(sessionId, "test-key");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("test-value");
    });

    it("loadContext returns null for missing key", () => {
      expect(state.loadContext(sessionId, "missing-key")).toBeNull();
    });

    it("loadAllContext returns all entries for session", () => {
      state.saveContext({ sessionId, key: "k1", value: "v1" });
      state.saveContext({ sessionId, key: "k2", value: "v2" });
      const all = state.loadAllContext(sessionId);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("deleteContext removes entry", () => {
      state.saveContext({ sessionId, key: "to-delete", value: "x" });
      state.deleteContext(sessionId, "to-delete");
      expect(state.loadContext(sessionId, "to-delete")).toBeNull();
    });
  });

  describe("generateResumeContext", () => {
    it("returns empty string for unknown session", () => {
      expect(state.generateResumeContext("nonexistent")).toBe("");
    });

    it("returns markdown with objective and context for known session", () => {
      const session = state.createSession({ objective: "resume test" });
      state.saveContext({ sessionId: session.id, key: "ctx", value: "data" });
      const text = state.generateResumeContext(session.id);
      expect(text).toContain("resume test");
      expect(text).toContain("Previous Session Context");
      expect(text).toContain("ctx");
    });
  });
});
