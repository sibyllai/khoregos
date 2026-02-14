# Khoregos

**Enterprise governance layer for Claude Code Agent Teams**

Khoregos (k6s) provides audit trails, session persistence, and agent boundaries for Claude Code's native Agent Teams feature.

## Philosophy

Khoregos is designed around three principles:

1. **Non-invasive**: Never patches or monkey-patches Claude Code internals.
2. **Durable**: Uses stable interfaces (MCP, filesystem) that won't break on Claude Code updates.
3. **Graceful degradation**: If Khoregos is down, agents still work (just without governance).

## Features

### Audit trail

Every file change, decision, and action is logged with timestamps, agent attribution, and severity classification (`info`, `warning`, `critical`). Filterable, exportable (JSON/CSV), and live-streamable.

### Session persistence

Stop work, resume later with full context preserved. Sessions capture the objective, operator identity, git context (branch, SHA, dirty state), and all agent activity.

### Agent boundaries

Define which files each agent can modify via glob patterns in `k6s.yaml`. Advisory mode (logged) by default; strict enforcement planned for Phase 4.

### File locks

Prevent multiple agents from editing the same file simultaneously via `k6s_acquire_lock` / `k6s_release_lock` MCP tools.

### Sensitive-file annotations

Configurable file patterns in `k6s.yaml` flag audit events when sensitive files are modified (e.g., `package.json`, `.env*`, `**/auth/**`). These appear as `sensitive_needs_review` events in the audit trail.

The `sensitive_needs_review` label is intentional: compliance frameworks such as SOC 2 (CC6.1 change management), ISO 27001 (A.8.32 change management), and HIPAA (164.312(e) integrity controls) require evidence that changes to security-sensitive areas were reviewed by a human. These audit annotations surface exactly which files need post-hoc human review during the commit or pull request stage, without imposing an interactive approval workflow at agent runtime.

### MCP integration

Agents use governance tools via standard MCP protocol. No special agent modifications required — governance instructions are injected into `CLAUDE.md` automatically.

## Installation

```bash
cd khoregos
npm install
npm run build
```

Link the CLI globally (optional):

```bash
npm link
```

## Quick start

### 1. Initialize your project

```bash
cd your-project
k6s init
```

This creates:

- `k6s.yaml` — configuration for boundaries and sensitive-file rules.
- `.khoregos/` — directory for database and runtime state.

### 2. Start an agent team session

```bash
k6s team start "Implement user authentication with OAuth2"
```

This:

- Creates a new session in the database with operator/git context.
- Injects governance rules into `CLAUDE.md`.
- Registers the MCP server and hooks in `.claude/settings.json`.

### 3. Work with agents

Agents will automatically see governance instructions and can use MCP tools:

- `k6s_log` — log actions to audit trail.
- `k6s_save_context` / `k6s_load_context` — persistent context.
- `k6s_acquire_lock` / `k6s_release_lock` — file locks.
- `k6s_get_boundaries` / `k6s_check_path` — boundary awareness.
- `k6s_task_update` — task state tracking.

### 4. View audit trail

```bash
k6s audit show                      # Latest session events
k6s audit show --severity critical  # Security-relevant events only
k6s audit tail                      # Live stream
k6s audit export --format json      # Export for analysis
```

### 5. Resume later

```bash
k6s team resume
```

## CLI reference

```
k6s
├── init                                # Initialize project
├── team
│   ├── start <objective> [--run]       # Start agent team with governance
│   ├── stop                            # Stop team, capture state
│   ├── resume [session-id]             # Resume previous session
│   ├── status                          # Current team status
│   └── history                         # List past sessions
├── audit
│   ├── show [--session] [--agent] [--type] [--severity] [--since]
│   ├── export [--format json|csv] [--output <file>]
│   └── tail [--no-follow]              # Live stream
├── session
│   ├── list                            # All sessions
│   ├── show <id>                       # Session details
│   ├── latest                          # Most recent session
│   ├── context <id>                    # View saved context
│   └── delete <id>                     # Delete session
├── status                              # Current status
├── mcp serve                           # Start MCP server (internal)
└── version                             # Show version
```

## Configuration

Edit `k6s.yaml` to configure boundaries and sensitive-file audit rules:

```yaml
version: "1"

project:
  name: "my-project"

session:
  context_retention_days: 90
  audit_retention_days: 365

boundaries:
  - pattern: "frontend-*"
    allowed_paths:
      - "src/frontend/**"
      - "src/shared/**"
    forbidden_paths:
      - ".env*"
      - "src/backend/**"
    enforcement: advisory

gates:
  - id: dependency-approval
    name: "New Dependency Approval"
    trigger:
      file_patterns:
        - "package.json"
        - "requirements.txt"
    approval_mode: manual
    timeout_seconds: 1800
    notify: ["terminal"]

  - id: security-files
    name: "Security File Changes"
    trigger:
      file_patterns:
        - ".env*"
        - "**/auth/**"
        - "**/*.pem"
    approval_mode: manual
    timeout_seconds: 1800
    notify: ["terminal"]
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run CLI in dev mode (no build step)
npm run dev

# Run tests
npm test

# Type-check without emitting
npx tsc --noEmit
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Human Operator                        │
│                   (CLI, Dashboard)                       │
├─────────────────────────────────────────────────────────┤
│                 K6S GOVERNANCE ENGINE                    │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐          │
│  │  Audit   │ │ Boundary │ │  Sensitivity  │          │
│  │  Logger  │ │ Enforcer │ │  Annotator    │          │
│  └──────────┘ └──────────┘ └───────────────┘          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐    │
│  │  State   │ │  Lock    │ │  Severity Classifier  │    │
│  │  Manager │ │  Manager │ │                       │    │
│  └──────────┘ └──────────┘ └──────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐   │
│  │              SQLite Store (.khoregos/k6s.db)      │   │
│  └──────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌─────────────────────┐          │
│  │  MCP Server   │    │  Filesystem Watcher  │          │
│  │  (governance  │    │  (chokidar)          │          │
│  │   tools)      │    │                      │          │
│  └───────────────┘    └─────────────────────┘          │
├─────────────────────────────────────────────────────────┤
│              CLAUDE CODE + AGENT TEAMS                   │
│                                                          │
│  Lead Agent ──► Teammate 1                               │
│              ──► Teammate 2                               │
└─────────────────────────────────────────────────────────┘
```

## Roadmap

- **Phase 1** (complete): Audit trail, sessions, boundaries, locks.
- **Phase 2** (complete): Sensitive-file annotations, severity classification, operator/git attribution.
- **Phase 3**: Dashboard, OpenTelemetry, Prometheus, webhooks, HMAC audit signing.
- **Phase 4**: Strict enforcement, plugin system.
- **Phase 5**: Compliance tooling, audit report generation.
- **Phase 6**: Enterprise features (SSO, RBAC, PostgreSQL backend).

## License

MIT
