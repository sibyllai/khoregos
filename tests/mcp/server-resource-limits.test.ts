/**
 * Tests for MCP resource-limit warning behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { K6sServer } from "../../src/mcp/server.js";
import { K6sConfigSchema } from "../../src/models/config.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("K6sServer resource limits", () => {
  let db: Db;
  let state: StateManager;
  let sessionId: string;

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
    state = new StateManager(db, "/tmp/k6s-mcp-resource-test");
    const session = state.createSession({ objective: "mcp resource test" });
    sessionId = session.id;
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("returns warning text when agent exceeds configured max_tool_calls_per_session", () => {
    const agent = state.registerAgent({ sessionId, name: "primary" });
    for (let i = 0; i < 6; i += 1) {
      state.incrementToolCallCount(agent.id);
    }

    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      boundaries: [
        {
          pattern: "*",
          enforcement: "advisory",
          max_tool_calls_per_session: 5,
        },
      ],
    });
    const server = new K6sServer(db, config, sessionId, "/tmp/k6s-mcp-resource-test");
    const warning = (
      server as unknown as { checkResourceLimit: (agentName: string) => string | null }
    ).checkResourceLimit("primary");

    expect(warning).toContain("RESOURCE_LIMIT_WARNING");
    expect(warning).toContain("(6/5)");
  });

  it("returns null when no limit is configured", () => {
    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      boundaries: [
        {
          pattern: "*",
          enforcement: "advisory",
        },
      ],
    });
    const server = new K6sServer(db, config, sessionId, "/tmp/k6s-mcp-resource-test");
    const warning = (
      server as unknown as { checkResourceLimit: (agentName: string) => string | null }
    ).checkResourceLimit("primary");
    expect(warning).toBeNull();
  });

  it("appends warning in actual k6s_log MCP tool response when exceeded", async () => {
    const agent = state.registerAgent({ sessionId, name: "handler-agent" });
    for (let i = 0; i < 3; i += 1) {
      state.incrementToolCallCount(agent.id);
    }

    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      boundaries: [
        {
          pattern: "*",
          enforcement: "advisory",
          max_tool_calls_per_session: 2,
        },
      ],
    });
    const server = new K6sServer(db, config, sessionId, "/tmp/k6s-mcp-resource-test");
    const tools = (
      server as unknown as {
        mcp: {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<{ content: Array<{ type: string; text: string }> }>;
            }
          >;
        };
      }
    ).mcp._registeredTools;
    const res = await tools.k6s_log.handler({
      action: "unit test action",
      event_type: "log",
      agent_name: "handler-agent",
    });
    expect(res.content[0].text).toContain("\"status\":\"logged\"");
    expect(res.content[0].text).toContain("RESOURCE_LIMIT_WARNING");
    expect(res.content[0].text).toContain("(3/2)");
  });
});
