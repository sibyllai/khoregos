# Khoregos

**Enterprise governance layer for Claude Code Agent Teams**

Khoregos (k6s) provides audit trails, session persistence, boundaries, and human approval gates for Claude Code's native Agent Teams feature.

## Philosophy

Khoregos is designed around three principles:

1. **Non-invasive**: Never patches or monkey-patches Claude Code internals
2. **Durable**: Uses stable interfaces (MCP, filesystem) that won't break on Claude Code updates
3. **Graceful degradation**: If Khoregos is down, agents still work (just without governance)

## Features (Phase 1)

- **Audit Trail**: Every file change, decision, and action is logged with timestamps and attribution
- **Session Persistence**: Stop work, resume later with full context preserved
- **Agent Boundaries**: Define which files each agent can modify (advisory mode)
- **File Locks**: Prevent multiple agents from editing the same file simultaneously
- **MCP Integration**: Agents use governance tools via standard MCP protocol

## Installation

```bash
pip install khoregos
```

Or for development:

```bash
cd khoregos-v2
pip install -e ".[dev]"
```

## Quick Start

### 1. Initialize your project

```bash
cd your-project
k6s init
```

This creates:
- `k6s.yaml` - Configuration for boundaries and gates
- `.khoregos/` - Directory for database and runtime state

### 2. Start an agent team session

```bash
k6s team start "Implement user authentication with OAuth2"
```

This:
- Creates a new session in the database
- Injects governance rules into CLAUDE.md
- Registers the MCP server for agent access
- Launches Claude Code

### 3. Work with agents

Agents will automatically see governance instructions and can use MCP tools:

- `k6s_log` - Log actions to audit trail
- `k6s_save_context` - Save persistent context
- `k6s_load_context` - Load saved context
- `k6s_acquire_lock` / `k6s_release_lock` - File locks
- `k6s_get_boundaries` - Check allowed/forbidden paths
- `k6s_check_path` - Verify path access before modifying

### 4. View audit trail

```bash
k6s audit show
k6s audit tail --follow
```

### 5. Resume later

```bash
k6s team resume
```

## CLI Reference

```
k6s
├── init                          # Initialize project
├── team
│   ├── start <objective>         # Start agent team with governance
│   ├── stop                      # Stop team, capture state
│   ├── resume [session-id]       # Resume previous session
│   ├── status                    # Current team status
│   └── history                   # List past sessions
├── audit
│   ├── show [--session] [--agent] [--type]
│   ├── export [--format json|csv]
│   └── tail                      # Live stream
├── session
│   ├── list                      # All sessions
│   ├── show <id>                 # Session details
│   ├── context <id>              # View saved context
│   └── delete <id>               # Delete session
├── status                        # Current status
└── version                       # Show version
```

## Configuration

Edit `k6s.yaml` to configure boundaries and gates:

```yaml
version: "1"

project:
  name: "my-project"

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
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy src/k6s

# Linting
ruff check src/k6s
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Human Operator                        │
│                   (CLI, Dashboard)                       │
├─────────────────────────────────────────────────────────┤
│                 K6S GOVERNANCE ENGINE                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐     │
│  │  Audit   │ │ Boundary │ │   State  │ │  Lock  │     │
│  │  Logger  │ │ Enforcer │ │  Manager │ │ Manager│     │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘     │
│  ┌──────────────────────────────────────────────────┐   │
│  │              SQLite Store (.khoregos/k6s.db)      │   │
│  └──────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌─────────────────────┐          │
│  │  MCP Server   │    │  Filesystem Watcher  │          │
│  │  (governance  │    │  (inotify/fsevents)  │          │
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

- **Phase 1** (Current): Audit trail, sessions, boundaries, locks
- **Phase 2**: Human approval gates, cost tracking
- **Phase 3**: Dashboard, OpenTelemetry, webhooks
- **Phase 4**: Strict enforcement, plugin system
- **Phase 5**: Git export, multi-developer support
- **Phase 6**: Enterprise features

## License

MIT
