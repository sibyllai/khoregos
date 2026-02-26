/**
 * Tests for hook duration extraction helpers.
 */

import { describe, it, expect } from "vitest";
import { extractDurationMs, parseTimestampMs } from "../../src/cli/hook.js";

describe("parseTimestampMs", () => {
  it("parses ISO-8601 timestamps", () => {
    const value = parseTimestampMs("2026-02-26T10:30:00.000Z");
    expect(value).toBe(1772101800000);
  });

  it("treats small numeric timestamps as seconds", () => {
    expect(parseTimestampMs(1700000000)).toBe(1700000000000);
  });

  it("treats large numeric timestamps as milliseconds", () => {
    expect(parseTimestampMs(1700000000000)).toBe(1700000000000);
  });

  it("returns undefined for unparseable values", () => {
    expect(parseTimestampMs("not-a-time")).toBeUndefined();
    expect(parseTimestampMs({})).toBeUndefined();
  });
});

describe("extractDurationMs", () => {
  it("prefers explicit duration_ms when provided", () => {
    const duration = extractDurationMs({
      duration_ms: 750,
      started_at: "2026-02-26T10:30:00.000Z",
      ended_at: "2026-02-26T10:30:03.000Z",
    });
    expect(duration).toBe(750);
  });

  it("uses timing.durationMs when top-level values are missing", () => {
    const duration = extractDurationMs({
      timing: { durationMs: 900 },
    });
    expect(duration).toBe(900);
  });

  it("derives duration from start and end timestamps", () => {
    const duration = extractDurationMs({
      started_at: "2026-02-26T10:30:00.000Z",
      ended_at: "2026-02-26T10:30:03.200Z",
    });
    expect(duration).toBe(3200);
  });

  it("returns undefined when duration cannot be derived", () => {
    expect(extractDurationMs({ started_at: "not-a-time" })).toBeUndefined();
    expect(extractDurationMs({ started_at: "2026-02-26T10:30:00.000Z" })).toBeUndefined();
    expect(extractDurationMs({ started_at: "2026-02-26T10:30:03.000Z", ended_at: "2026-02-26T10:30:00.000Z" })).toBeUndefined();
  });

  it("rejects explicit duration values above the security cap", () => {
    expect(extractDurationMs({ duration_ms: 3_600_001 })).toBeUndefined();
    expect(extractDurationMs({ durationMs: 3_600_001 })).toBeUndefined();
  });

  it("rejects derived duration values above the security cap", () => {
    const duration = extractDurationMs({
      started_at: "2026-02-26T10:30:00.000Z",
      ended_at: "2026-02-26T11:30:00.001Z",
    });
    expect(duration).toBeUndefined();
  });

  it("accepts duration values at the security cap", () => {
    expect(extractDurationMs({ duration_ms: 3_600_000 })).toBe(3_600_000);
  });
});
