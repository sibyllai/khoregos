/**
 * Context storage, file lock, and boundary violation models.
 */

import { z } from "zod";
import type { Row } from "../store/db.js";

// Context entry

export const ContextEntrySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  agentId: z.string().nullable().default(null),
  value: z.string(),
  updatedAt: z.string().default(() => new Date().toISOString()),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

export function contextEntryToDbRow(e: ContextEntry): Row {
  return {
    key: e.key,
    session_id: e.sessionId,
    agent_id: e.agentId,
    value: e.value,
    updated_at: e.updatedAt,
  };
}

export function contextEntryFromDbRow(row: Row): ContextEntry {
  return {
    key: row.key as string,
    sessionId: row.session_id as string,
    agentId: (row.agent_id as string) ?? null,
    value: row.value as string,
    updatedAt: row.updated_at as string,
  };
}

// File lock

export const FileLockSchema = z.object({
  path: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  acquiredAt: z.string().default(() => new Date().toISOString()),
  expiresAt: z.string().nullable().default(null),
});
export type FileLock = z.infer<typeof FileLockSchema>;

export function fileLockToDbRow(l: FileLock): Row {
  return {
    path: l.path,
    session_id: l.sessionId,
    agent_id: l.agentId,
    acquired_at: l.acquiredAt,
    expires_at: l.expiresAt,
  };
}

export function fileLockFromDbRow(row: Row): FileLock {
  return {
    path: row.path as string,
    sessionId: row.session_id as string,
    agentId: row.agent_id as string,
    acquiredAt: row.acquired_at as string,
    expiresAt: (row.expires_at as string) ?? null,
  };
}

export function isLockExpired(l: FileLock): boolean {
  if (!l.expiresAt) return false;
  return new Date() > new Date(l.expiresAt);
}

// Boundary violation

export const BoundaryViolationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string().nullable().default(null),
  timestamp: z.string().default(() => new Date().toISOString()),
  filePath: z.string(),
  violationType: z.string(),
  enforcementAction: z.string(),
  details: z.string().nullable().default(null),
});
export type BoundaryViolation = z.infer<typeof BoundaryViolationSchema>;

export function boundaryViolationToDbRow(v: BoundaryViolation): Row {
  return {
    id: v.id,
    session_id: v.sessionId,
    agent_id: v.agentId,
    timestamp: v.timestamp,
    file_path: v.filePath,
    violation_type: v.violationType,
    enforcement_action: v.enforcementAction,
    details: v.details,
  };
}

export function boundaryViolationFromDbRow(row: Row): BoundaryViolation {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    agentId: (row.agent_id as string) ?? null,
    timestamp: row.timestamp as string,
    filePath: row.file_path as string,
    violationType: row.violation_type as string,
    enforcementAction: row.enforcement_action as string,
    details: (row.details as string) ?? null,
  };
}
