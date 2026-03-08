import { describe, expect, it } from "vitest";
import { K6sConfigSchema } from "../../src/models/config.js";
import { getDashboardHTML } from "../../src/engine/dashboard-template.js";

describe("getDashboardHTML", () => {
  const config = K6sConfigSchema.parse({ project: { name: "test-project" } });
  const sessionId = "01ABCDEFGHIJKLMNOPQRSTUV";

  it("returns valid HTML containing the session ID", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("01ABCDEF");
    expect(html).toContain("test-project");
  });

  it("contains CSS design tokens", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("--bg: #0B0B09");
    expect(html).toContain("--surface: #131310");
    expect(html).toContain("--amber: #F0900A");
    expect(html).toContain("--text: #F0EDE7");
    expect(html).toContain("--green: #4ADE80");
    expect(html).toContain("--yellow: #FCD34D");
    expect(html).toContain("--red: #F87171");
    expect(html).toContain("--blue: #60A5FA");
  });

  it("contains light theme tokens", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("--bg: #F9F5EE");
    expect(html).toContain("--amber: #9A4E04");
  });

  it("contains SSE connection code", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("EventSource");
    expect(html).toContain("/events");
  });

  it("contains font references", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("Plus Jakarta Sans");
    expect(html).toContain("IBM Plex Mono");
  });

  it("contains fractal noise grain overlay", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("fractalNoise");
  });

  it("contains API fetch calls", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("/api/events");
    expect(html).toContain("/api/cost");
    expect(html).toContain("/api/agents");
    expect(html).toContain("/api/review");
    expect(html).toContain("/api/sessions");
  });

  it("contains filter controls", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("filterType");
    expect(html).toContain("filterSeverity");
    expect(html).toContain("filterAgent");
    expect(html).toContain("searchInput");
  });

  it("contains export buttons", () => {
    const html = getDashboardHTML(sessionId, config);
    expect(html).toContain("exportJSON");
    expect(html).toContain("exportCSV");
  });

  it("escapes HTML in project name", () => {
    const xssConfig = K6sConfigSchema.parse({ project: { name: '<script>alert("xss")</script>' } });
    const html = getDashboardHTML(sessionId, xssConfig);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});
