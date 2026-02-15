/**
 * HMAC signing for tamper-evident audit trails.
 *
 * Each audit event's hmac = HMAC-SHA256(key, previousHmac + canonical(event)).
 * This creates a hash chain — tampering with any event invalidates all
 * subsequent HMACs.
 *
 * Key is generated at `k6s init` and stored in .khoregos/signing.key
 * with 0o600 permissions.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AuditEvent } from "../models/audit.js";

const KEY_FILENAME = "signing.key";
const KEY_BYTES = 32; // 256-bit.

/**
 * Generate a new signing key and write it to the .khoregos directory.
 * Returns true if the key was created, false if it already exists.
 */
export function generateSigningKey(khoregoDir: string): boolean {
  const keyPath = path.join(khoregoDir, KEY_FILENAME);
  if (existsSync(keyPath)) return false;
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return true;
}

/**
 * Load the signing key from the .khoregos directory.
 * Returns null if no key file exists (HMAC signing is optional).
 */
export function loadSigningKey(khoregoDir: string): Buffer | null {
  const keyPath = path.join(khoregoDir, KEY_FILENAME);
  if (!existsSync(keyPath)) return null;
  const hex = readFileSync(keyPath, "utf-8").trim();
  return Buffer.from(hex, "hex");
}

/**
 * Produce a canonical string representation of an audit event.
 * Excludes the `hmac` field itself. Keys are sorted for determinism.
 */
export function canonicalizeEvent(event: AuditEvent): string {
  const obj: Record<string, unknown> = {};
  const keys = Object.keys(event).filter((k) => k !== "hmac").sort();
  for (const k of keys) {
    obj[k] = event[k as keyof AuditEvent];
  }
  return JSON.stringify(obj);
}

/**
 * Compute the HMAC for an event in the chain.
 *
 * @param key - The signing key buffer.
 * @param previousHmac - The HMAC of the previous event, or the genesis value.
 * @param event - The audit event (hmac field will be ignored).
 */
export function computeHmac(
  key: Buffer,
  previousHmac: string,
  event: AuditEvent,
): string {
  const payload = previousHmac + canonicalizeEvent(event);
  return createHmac("sha256", key).update(payload).digest("hex");
}

/** Genesis value for the first event in a session's HMAC chain. */
export function genesisValue(sessionId: string): string {
  return `k6s:genesis:${sessionId}`;
}

/**
 * Verify the HMAC chain for a list of events (must be in sequence order).
 * Returns a result object describing chain integrity.
 */
export function verifyChain(
  key: Buffer,
  sessionId: string,
  events: AuditEvent[],
): VerifyResult {
  if (events.length === 0) {
    return { valid: true, eventsChecked: 0, errors: [] };
  }

  const errors: VerifyError[] = [];
  let previousHmac = genesisValue(sessionId);
  let lastSequence = 0;

  for (const event of events) {
    // Check for sequence gaps.
    if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
      errors.push({
        sequence: event.sequence,
        type: "gap",
        message: `sequence gap: expected ${lastSequence + 1}, got ${event.sequence}`,
      });
    }

    // Check for missing HMAC.
    if (!event.hmac) {
      errors.push({
        sequence: event.sequence,
        type: "missing",
        message: "event has no HMAC (unsigned)",
      });
      // Can't continue chain verification from an unsigned event.
      // Use genesis to keep going so we can report further issues.
      lastSequence = event.sequence;
      continue;
    }

    const expected = computeHmac(key, previousHmac, event);
    if (event.hmac !== expected) {
      errors.push({
        sequence: event.sequence,
        type: "mismatch",
        message: `HMAC mismatch at sequence ${event.sequence}`,
        expected,
        actual: event.hmac,
      });
    }

    previousHmac = event.hmac;
    lastSequence = event.sequence;
  }

  return {
    valid: errors.length === 0,
    eventsChecked: events.length,
    errors,
  };
}

export interface VerifyError {
  sequence: number;
  type: "gap" | "missing" | "mismatch";
  message: string;
  expected?: string;
  actual?: string;
}

export interface VerifyResult {
  valid: boolean;
  eventsChecked: number;
  errors: VerifyError[];
}
