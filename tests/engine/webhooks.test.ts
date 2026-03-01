import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookDispatcher } from "../../src/engine/webhooks.js";
import type { AuditEvent } from "../../src/models/audit.js";

const baseEvent: AuditEvent = {
  id: "01KJTEST000000000000000000",
  timestamp: "2026-03-01T00:00:00.000Z",
  sequence: 1,
  sessionId: "01KJSESSION0000000000000000",
  agentId: null,
  eventType: "gate_triggered",
  action: "test event",
  details: null,
  filesAffected: null,
  gateId: null,
  hmac: null,
  severity: "info",
};

const sessionContext = {
  sessionId: "01KJSESSION0000000000000000",
  traceId: "trace-test-123",
};

describe("WebhookDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.K6S_WEBHOOK_SECRET_TEST;
  });

  it("dispatches matching events and includes a valid HMAC signature header", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
        }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );

    process.env.K6S_WEBHOOK_SECRET_TEST = "test-secret-123";
    const dispatcher = new WebhookDispatcher([
      {
        url: "http://localhost:8888/webhook",
        events: ["gate_triggered"],
        secret: "$K6S_WEBHOOK_SECRET_TEST",
      },
    ]);

    dispatcher.dispatch(baseEvent, sessionContext);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8888/webhook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("khoregos-webhook/1.0");

    const body = init.body as string;
    const expected = `sha256=${createHmac("sha256", "test-secret-123").update(body).digest("hex")}`;
    expect(headers["X-K6s-Signature"]).toBe(expected);
  });

  it("skips webhook delivery when event type does not match filter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const dispatcher = new WebhookDispatcher([
      {
        url: "http://localhost:8888/webhook",
        events: ["boundary_violation"],
      },
    ]);

    dispatcher.dispatch({ ...baseEvent, eventType: "tool_use" }, sessionContext);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits signature header when no secret is configured", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
        }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );

    const dispatcher = new WebhookDispatcher([
      {
        url: "http://localhost:8888/webhook",
        events: [],
      },
    ]);

    dispatcher.dispatch(baseEvent, sessionContext);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-K6s-Signature"]).toBeUndefined();
  });

  it("retries failed deliveries with 1s and 4s backoff across 3 attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => {
        throw new Error("network down");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const dispatcher = new WebhookDispatcher([
      {
        url: "http://127.0.0.1:8899/webhook",
        events: [],
      },
    ]);

    dispatcher.dispatch(baseEvent, sessionContext);

    await vi.runAllTicks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Webhook delivery failed");
  });
});
