import { describe, expect, it } from "vitest";
import { K6sConfigSchema } from "../../src/models/config.js";

describe("DashboardConfigSchema", () => {
  it("has default values", () => {
    const config = K6sConfigSchema.parse({ project: { name: "test" } });
    expect(config.dashboard).toBeDefined();
    expect(config.dashboard.port).toBe(6100);
    expect(config.dashboard.host).toBe("localhost");
    expect(config.dashboard.open_browser).toBe(true);
  });

  it("accepts custom port and host", () => {
    const config = K6sConfigSchema.parse({
      project: { name: "test" },
      dashboard: { port: 8080, host: "0.0.0.0", open_browser: false },
    });
    expect(config.dashboard.port).toBe(8080);
    expect(config.dashboard.host).toBe("0.0.0.0");
    expect(config.dashboard.open_browser).toBe(false);
  });
});
