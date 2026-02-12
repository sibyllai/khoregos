/**
 * Database schema migrations for Khoregos.
 */

export const SCHEMA_VERSION = 1;

type Migration = [version: number, sql: string];

const MIGRATIONS: Migration[] = [
  [
    1,
    `
    -- Core session tracking
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'created',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        parent_session_id TEXT,
        config_snapshot TEXT,
        context_summary TEXT,
        total_cost_usd REAL DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        metadata TEXT
    );

    -- Agent registry (per-session)
    CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL,
        role TEXT,
        specialization TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        spawned_at TEXT NOT NULL,
        boundary_config TEXT,
        metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

    -- Audit trail (append-only)
    CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_id TEXT REFERENCES agents(id),
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        files_affected TEXT,
        gate_id TEXT,
        hmac TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);

    -- Gates (Phase 2, but create table now for schema stability)
    CREATE TABLE IF NOT EXISTS gates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id),
        state TEXT NOT NULL DEFAULT 'pending',
        trigger_event_id TEXT REFERENCES audit_events(id),
        triggered_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        reason TEXT,
        details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gates_pending ON gates(session_id, state);

    -- Cost tracking
    CREATE TABLE IF NOT EXISTS cost_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        task_id TEXT,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_records(session_id);

    -- Persistent context (survives sessions)
    CREATE TABLE IF NOT EXISTS context_store (
        key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_id TEXT,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key, session_id)
    );

    -- File locks
    CREATE TABLE IF NOT EXISTS file_locks (
        path TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT
    );

    -- Boundary violations
    CREATE TABLE IF NOT EXISTS boundary_violations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        timestamp TEXT NOT NULL,
        file_path TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        enforcement_action TEXT NOT NULL,
        details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_violations_session ON boundary_violations(session_id);
    `,
  ],
];

export function getMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a[0] - b[0]);
}
