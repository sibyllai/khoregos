/**
 * Tests for RFC 3161 timestamp request helpers.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installTimestampCertificates,
  requestTimestamp,
  verifyTimestamp,
  verifyTimestampStrict,
} from "../../src/engine/timestamp.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

describe("timestamp", () => {
  it("requestTimestamp posts DER body and returns raw response", async () => {
    const chainHash = createHash("sha256").update("hmac-value", "utf8").digest();
    const responseBuffer = Buffer.concat([Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), chainHash]);
    const port = await getFreePort();
    let receivedContentType = "";
    let receivedLength = 0;
    const server = createServer((req, res) => {
      receivedContentType = String(req.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        receivedLength = Buffer.concat(chunks).length;
        res.writeHead(200, { "Content-Type": "application/timestamp-reply" });
        res.end(responseBuffer);
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

    try {
      const response = await requestTimestamp(chainHash, `http://127.0.0.1:${port}/tsa`);
      expect(receivedContentType).toBe("application/timestamp-query");
      expect(receivedLength).toBeGreaterThan(0);
      expect(response.equals(responseBuffer)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("verifyTimestamp returns true only when chain hash is embedded", () => {
    const chainHash = createHash("sha256").update("hmac-value", "utf8").digest();
    const good = Buffer.concat([Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), chainHash]);
    const bad = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    expect(verifyTimestamp(chainHash, good)).toBe(true);
    expect(verifyTimestamp(chainHash, bad)).toBe(false);
  });

  it("verifyTimestampStrict returns false when trust files are invalid", () => {
    const chainHash = createHash("sha256").update("hmac-value", "utf8").digest();
    const response = Buffer.concat([Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), chainHash]);
    const ok = verifyTimestampStrict(chainHash, response, {
      caCertFile: "/tmp/does-not-exist-ca.pem",
    });
    expect(ok).toBe(false);
  });

  it("installTimestampCertificates downloads certs from authority files endpoints", async () => {
    const port = await getFreePort();
    const projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-ts-certs-"));
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      "MIIB",
      "-----END CERTIFICATE-----",
      "",
    ].join("\n");
    const server = createServer((req, res) => {
      if (req.url === "/files/cacert.pem" || req.url === "/files/tsa.crt") {
        res.writeHead(200, { "Content-Type": "application/x-pem-file" });
        res.end(pem);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

    try {
      const installed = await installTimestampCertificates(
        `http://127.0.0.1:${port}/tsr`,
        projectRoot,
      );
      expect(installed.caCertFile).toBeTruthy();
      expect(installed.tsaCertFile).toBeTruthy();
      expect(existsSync(installed.caCertFile!)).toBe(true);
      expect(readFileSync(installed.caCertFile!, "utf-8")).toContain("BEGIN CERTIFICATE");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
