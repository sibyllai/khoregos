/**
 * Tests for agent model: schema, toDbRow/fromDbRow, isAgentActive.
 */

import { describe, it, expect } from "vitest";
import {
  AgentSchema,
  AgentRole,
  AgentState,
  agentToDbRow,
  agentFromDbRow,
  isAgentActive,
  type Agent,
} from "../../src/models/agent.js";

describe("agent model", () => {
  describe("AgentRole and AgentState", () => {
    it("AgentRole accepts lead and teammate", () => {
      expect(AgentRole.parse("lead")).toBe("lead");
      expect(AgentRole.parse("teammate")).toBe("teammate");
    });

    it("AgentState accepts active, idle, completed, failed", () => {
      expect(AgentState.parse("active")).toBe("active");
      expect(AgentState.parse("completed")).toBe("completed");
    });
  });

  describe("AgentSchema", () => {
    it("parses with defaults", () => {
      const agent = AgentSchema.parse({
        sessionId: "s1",
        name: "primary",
      });
      expect(agent.id).toBeDefined();
      expect(agent.role).toBe("teammate");
      expect(agent.state).toBe("active");
      expect(agent.claudeSessionId).toBeNull();
      expect(agent.toolCallCount).toBe(0);
    });
  });

  describe("agentToDbRow and agentFromDbRow", () => {
    it("roundtrips agent to db row and back", () => {
      const agent: Agent = {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sessionId: "s1",
        name: "primary",
        role: "lead",
        specialization: "backend",
        state: "active",
        spawnedAt: "2026-01-01T00:00:00.000Z",
        boundaryConfig: '{"allowed":["src/**"]}',
        metadata: null,
        claudeSessionId: "claude-1",
        toolCallCount: 3,
      };
      const row = agentToDbRow(agent);
      expect(row.name).toBe(agent.name);
      expect(row.role).toBe(agent.role);
      expect(row.claude_session_id).toBe(agent.claudeSessionId);
      expect(row.tool_call_count).toBe(agent.toolCallCount);

      const back = agentFromDbRow(row);
      expect(back.id).toBe(agent.id);
      expect(back.name).toBe(agent.name);
      expect(back.claudeSessionId).toBe(agent.claudeSessionId);
      expect(back.toolCallCount).toBe(agent.toolCallCount);
    });
  });

  describe("isAgentActive", () => {
    it("returns true for active and idle", () => {
      expect(isAgentActive({ state: "active" } as Agent)).toBe(true);
      expect(isAgentActive({ state: "idle" } as Agent)).toBe(true);
    });

    it("returns false for completed and failed", () => {
      expect(isAgentActive({ state: "completed" } as Agent)).toBe(false);
      expect(isAgentActive({ state: "failed" } as Agent)).toBe(false);
    });
  });
});
