import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import type { Db } from "../store/db.js";

export interface TimestampAnchor {
  id: string;
  sessionId: string;
  createdAt: string;
  chainHash: string;
  eventSequence: number;
  tsaResponse: string;
  tsaUrl: string;
  verified: boolean;
}

export interface InstalledTimestampCertificates {
  caCertFile: string | null;
  tsaCertFile: string | null;
}

export interface TimestampingRuntimeConfig {
  authorityUrl: string;
  strictVerify: boolean;
  caCertFile?: string;
  tsaCertFile?: string;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function derInteger(value: number | Buffer): Buffer {
  const content = typeof value === "number"
    ? (() => {
      if (value === 0) return Buffer.from([0x00]);
      const out: number[] = [];
      let n = value;
      while (n > 0) {
        out.unshift(n & 0xff);
        n >>= 8;
      }
      return Buffer.from(out);
    })()
    : value;
  const prefixed = content[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), content]) : content;
  return der(0x02, prefixed);
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derBoolean(value: boolean): Buffer {
  return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derOctetString(value: Buffer): Buffer {
  return der(0x04, value);
}

function derObjectIdentifier(oid: number[]): Buffer {
  if (oid.length < 2) throw new Error("oid must have at least 2 arcs");
  const bytes: number[] = [oid[0] * 40 + oid[1]];
  for (let i = 2; i < oid.length; i += 1) {
    const parts: number[] = [];
    let n = oid[i];
    parts.unshift(n & 0x7f);
    n >>= 7;
    while (n > 0) {
      parts.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    bytes.push(...parts);
  }
  return der(0x06, Buffer.from(bytes));
}

function derSequence(items: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(items));
}

export function createTimestampRequest(chainHash: Buffer): Buffer {
  const sha256Algorithm = derSequence([
    derObjectIdentifier([2, 16, 840, 1, 101, 3, 4, 2, 1]),
    derNull(),
  ]);
  const messageImprint = derSequence([
    sha256Algorithm,
    derOctetString(chainHash),
  ]);
  const nonce = derInteger(randomBytes(8));
  return derSequence([
    derInteger(1),
    messageImprint,
    nonce,
    derBoolean(true),
  ]);
}

function isPemCertificate(content: string): boolean {
  return content.includes("-----BEGIN CERTIFICATE-----")
    && content.includes("-----END CERTIFICATE-----");
}

async function tryDownloadText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    if (!isPemCertificate(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Attempt to download CA/TSA cert files from the TSA authority origin.
 * Certs are cached under .khoregos/timestamp-certs/<host>/.
 */
export async function installTimestampCertificates(
  tsaUrl: string,
  projectRoot: string,
): Promise<InstalledTimestampCertificates> {
  let origin: string;
  let host: string;
  try {
    const parsed = new URL(tsaUrl);
    origin = parsed.origin;
    host = parsed.host.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    return { caCertFile: null, tsaCertFile: null };
  }

  const certDir = path.join(projectRoot, ".khoregos", "timestamp-certs", host);
  const caPath = path.join(certDir, "cacert.pem");
  const tsaPath = path.join(certDir, "tsa.crt");

  const caCandidates = [
    `${origin}/files/cacert.pem`,
    `${origin}/cacert.pem`,
  ];
  const tsaCandidates = [
    `${origin}/files/tsa.crt`,
    `${origin}/tsa.crt`,
  ];

  let caPem: string | null = null;
  for (const candidate of caCandidates) {
    caPem = await tryDownloadText(candidate);
    if (caPem) break;
  }

  let tsaPem: string | null = null;
  for (const candidate of tsaCandidates) {
    tsaPem = await tryDownloadText(candidate);
    if (tsaPem) break;
  }

  if (!caPem && !tsaPem) {
    return { caCertFile: null, tsaCertFile: null };
  }

  mkdirSync(certDir, { recursive: true });
  if (caPem) {
    writeFileSync(caPath, caPem);
  }
  if (tsaPem) {
    writeFileSync(tsaPath, tsaPem);
  }

  return {
    caCertFile: caPem ? caPath : null,
    tsaCertFile: tsaPem ? tsaPath : null,
  };
}

export async function requestTimestamp(
  chainHash: Buffer,
  tsaUrl: string,
  requestBodyOverride?: Buffer,
): Promise<Buffer> {
  const requestBody = requestBodyOverride ?? createTimestampRequest(chainHash);
  const response = await fetch(tsaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/timestamp-query",
      "Accept": "application/timestamp-reply",
    },
    body: requestBody,
  });
  if (!response.ok) {
    throw new Error(`timestamp request failed: http ${response.status}`);
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0) {
    throw new Error("timestamp request failed: empty response");
  }
  return raw;
}

export function requestTimestampSync(
  chainHash: Buffer,
  tsaUrl: string,
  requestBodyOverride?: Buffer,
): Buffer {
  const requestBody = requestBodyOverride ?? createTimestampRequest(chainHash);
  try {
    const raw = execFileSync(
      "curl",
      [
        "-sS",
        "--fail-with-body",
        "-X",
        "POST",
        tsaUrl,
        "-H",
        "Content-Type: application/timestamp-query",
        "-H",
        "Accept: application/timestamp-reply",
        "--data-binary",
        "@-",
      ],
      { input: requestBody },
    );
    if (raw.length === 0) {
      throw new Error("timestamp request failed: empty response");
    }
    return raw;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`timestamp request failed: ${message}`);
  }
}

/**
 * Simplified verification: check ASN.1 envelope and embedded imprint bytes.
 */
export function verifyTimestamp(
  chainHash: Buffer,
  tsaResponse: Buffer,
): boolean {
  if (tsaResponse.length < 4) return false;
  if (tsaResponse[0] !== 0x30) return false;
  return tsaResponse.includes(chainHash);
}

/**
 * Strict verification using OpenSSL ts -verify.
 * This validates CMS signature and certificate chain against provided trust anchors.
 */
export function verifyTimestampStrict(
  chainHash: Buffer,
  tsaResponse: Buffer,
  opts: { caCertFile: string; tsaCertFile?: string; requestDer?: Buffer },
): boolean {
  const tempDir = mkdtempSync(path.join(tmpdir(), "k6s-ts-verify-"));
  const tsqPath = path.join(tempDir, "request.tsq");
  const tsrPath = path.join(tempDir, "response.tsr");
  try {
    writeFileSync(tsqPath, opts.requestDer ?? createTimestampRequest(chainHash));
    writeFileSync(tsrPath, tsaResponse);
    const args = [
      "ts",
      "-verify",
      "-in",
      tsrPath,
      "-queryfile",
      tsqPath,
      "-CAfile",
      opts.caCertFile,
    ];
    if (opts.tsaCertFile) {
      args.push("-untrusted", opts.tsaCertFile);
    }
    execFileSync("openssl", args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createTimestampAnchor(params: {
  sessionId: string;
  chainHash: Buffer;
  eventSequence: number;
  tsaResponse: Buffer;
  tsaUrl: string;
  verified: boolean;
}): TimestampAnchor {
  return {
    id: ulid(),
    sessionId: params.sessionId,
    createdAt: new Date().toISOString(),
    chainHash: params.chainHash.toString("hex"),
    eventSequence: params.eventSequence,
    tsaResponse: params.tsaResponse.toString("base64"),
    tsaUrl: params.tsaUrl,
    verified: params.verified,
  };
}

function tryDownloadTextSync(url: string): string | null {
  try {
    const response = execFileSync("curl", ["-sS", "--fail-with-body", url], {
      encoding: "utf-8",
    });
    if (!isPemCertificate(response)) return null;
    return response;
  } catch {
    return null;
  }
}

export function installTimestampCertificatesSync(
  tsaUrl: string,
  projectRoot: string,
): InstalledTimestampCertificates {
  let origin: string;
  let host: string;
  try {
    const parsed = new URL(tsaUrl);
    origin = parsed.origin;
    host = parsed.host.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    return { caCertFile: null, tsaCertFile: null };
  }

  const certDir = path.join(projectRoot, ".khoregos", "timestamp-certs", host);
  const caPath = path.join(certDir, "cacert.pem");
  const tsaPath = path.join(certDir, "tsa.crt");

  const caCandidates = [
    `${origin}/files/cacert.pem`,
    `${origin}/cacert.pem`,
  ];
  const tsaCandidates = [
    `${origin}/files/tsa.crt`,
    `${origin}/tsa.crt`,
  ];

  let caPem: string | null = null;
  for (const candidate of caCandidates) {
    caPem = tryDownloadTextSync(candidate);
    if (caPem) break;
  }

  let tsaPem: string | null = null;
  for (const candidate of tsaCandidates) {
    tsaPem = tryDownloadTextSync(candidate);
    if (tsaPem) break;
  }

  if (!caPem && !tsaPem) {
    return { caCertFile: null, tsaCertFile: null };
  }

  mkdirSync(certDir, { recursive: true });
  if (caPem) {
    writeFileSync(caPath, caPem);
  }
  if (tsaPem) {
    writeFileSync(tsaPath, tsaPem);
  }

  return {
    caCertFile: caPem ? caPath : null,
    tsaCertFile: tsaPem ? tsaPath : null,
  };
}

export async function createAndStoreTimestampAnchorFromHmac(params: {
  db: Db;
  sessionId: string;
  eventSequence: number;
  eventHmac: string;
  timestamping: TimestampingRuntimeConfig;
  projectRoot: string;
}): Promise<TimestampAnchor> {
  const chainHash = createHash("sha256").update(params.eventHmac, "utf8").digest();
  const requestDer = params.timestamping.strictVerify ? createTimestampRequest(chainHash) : undefined;
  const tsaResponse = await requestTimestamp(
    chainHash,
    params.timestamping.authorityUrl,
    requestDer,
  );
  let verified = verifyTimestamp(chainHash, tsaResponse);

  if (params.timestamping.strictVerify) {
    let caCertFile = params.timestamping.caCertFile;
    let tsaCertFile = params.timestamping.tsaCertFile;
    const caMissing = !caCertFile || !existsSync(caCertFile);
    const tsaMissing = !tsaCertFile || !existsSync(tsaCertFile);
    if (caMissing || tsaMissing) {
      const installed = await installTimestampCertificates(
        params.timestamping.authorityUrl,
        params.projectRoot,
      );
      if (caMissing && installed.caCertFile) {
        caCertFile = installed.caCertFile;
      }
      if (tsaMissing && installed.tsaCertFile) {
        tsaCertFile = installed.tsaCertFile;
      }
    }
    if (!caCertFile || !existsSync(caCertFile)) {
      throw new Error(
        "strict timestamp verification requires a CA certificate file or downloadable authority cert",
      );
    }
    verified = verifyTimestampStrict(chainHash, tsaResponse, {
      caCertFile,
      tsaCertFile,
      requestDer,
    });
    if (!verified) {
      throw new Error("strict timestamp verification failed");
    }
  }

  const anchor = createTimestampAnchor({
    sessionId: params.sessionId,
    chainHash,
    eventSequence: params.eventSequence,
    tsaResponse,
    tsaUrl: params.timestamping.authorityUrl,
    verified,
  });
  params.db.insert("timestamps", {
    id: anchor.id,
    session_id: anchor.sessionId,
    created_at: anchor.createdAt,
    chain_hash: anchor.chainHash,
    event_sequence: anchor.eventSequence,
    tsa_response: anchor.tsaResponse,
    tsa_url: anchor.tsaUrl,
    verified: anchor.verified ? 1 : 0,
  });
  return anchor;
}

export function createAndStoreTimestampAnchorFromHmacSync(params: {
  db: Db;
  sessionId: string;
  eventSequence: number;
  eventHmac: string;
  timestamping: TimestampingRuntimeConfig;
  projectRoot: string;
}): TimestampAnchor {
  const chainHash = createHash("sha256").update(params.eventHmac, "utf8").digest();
  const requestDer = params.timestamping.strictVerify ? createTimestampRequest(chainHash) : undefined;
  const tsaResponse = requestTimestampSync(
    chainHash,
    params.timestamping.authorityUrl,
    requestDer,
  );
  let verified = verifyTimestamp(chainHash, tsaResponse);

  if (params.timestamping.strictVerify) {
    let caCertFile = params.timestamping.caCertFile;
    let tsaCertFile = params.timestamping.tsaCertFile;
    const caMissing = !caCertFile || !existsSync(caCertFile);
    const tsaMissing = !tsaCertFile || !existsSync(tsaCertFile);
    if (caMissing || tsaMissing) {
      const installed = installTimestampCertificatesSync(
        params.timestamping.authorityUrl,
        params.projectRoot,
      );
      if (caMissing && installed.caCertFile) {
        caCertFile = installed.caCertFile;
      }
      if (tsaMissing && installed.tsaCertFile) {
        tsaCertFile = installed.tsaCertFile;
      }
    }
    if (!caCertFile || !existsSync(caCertFile)) {
      throw new Error(
        "strict timestamp verification requires a CA certificate file or downloadable authority cert",
      );
    }
    verified = verifyTimestampStrict(chainHash, tsaResponse, {
      caCertFile,
      tsaCertFile,
      requestDer,
    });
    if (!verified) {
      throw new Error("strict timestamp verification failed");
    }
  }

  const anchor = createTimestampAnchor({
    sessionId: params.sessionId,
    chainHash,
    eventSequence: params.eventSequence,
    tsaResponse,
    tsaUrl: params.timestamping.authorityUrl,
    verified,
  });
  params.db.insert("timestamps", {
    id: anchor.id,
    session_id: anchor.sessionId,
    created_at: anchor.createdAt,
    chain_hash: anchor.chainHash,
    event_sequence: anchor.eventSequence,
    tsa_response: anchor.tsaResponse,
    tsa_url: anchor.tsaUrl,
    verified: anchor.verified ? 1 : 0,
  });
  return anchor;
}
