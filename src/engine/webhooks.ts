import { createHmac } from "node:crypto";
import { resolveWebhookSecret } from "../models/config.js";
import type { AuditEvent } from "../models/audit.js";

interface WebhookTarget {
  url: string;
  events: string[];
  secret: string | undefined;
}

interface SessionContext {
  sessionId: string;
  traceId?: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookDispatcher {
  private targets: WebhookTarget[];

  constructor(
    webhookConfigs: Array<{ url: string; events?: string[]; secret?: string }>,
  ) {
    this.targets = webhookConfigs.map((wh) => ({
      url: wh.url,
      events: wh.events ?? [],
      secret: resolveWebhookSecret(wh.secret),
    }));
  }

  dispatch(event: AuditEvent, sessionContext: SessionContext): void {
    // Fire-and-forget: start delivery without awaiting it.
    for (const target of this.targets) {
      if (target.events.length > 0 && !target.events.includes(event.eventType)) {
        continue;
      }
      this.deliver(target, event, sessionContext).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Webhook delivery failed for ${target.url}: ${message}.`);
      });
    }
  }

  private async deliver(
    target: WebhookTarget,
    event: AuditEvent,
    sessionContext: SessionContext,
    attempt = 1,
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    const payload = JSON.stringify({
      event,
      session: sessionContext,
      timestamp: new Date().toISOString(),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "khoregos-webhook/1.0",
    };

    if (target.secret) {
      const hmac = createHmac("sha256", target.secret).update(payload).digest("hex");
      headers["X-K6s-Signature"] = `sha256=${hmac}`;
    }

    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return;

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = Math.pow(4, attempt - 1) * 1000;
        await sleep(delayMs);
        return this.deliver(target, event, sessionContext, attempt + 1);
      }

      throw new Error(
        `HTTP ${response.status} ${response.statusText || "unknown status"}`,
      );
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = Math.pow(4, attempt - 1) * 1000;
        await sleep(delayMs);
        return this.deliver(target, event, sessionContext, attempt + 1);
      }
      throw err;
    }
  }
}
