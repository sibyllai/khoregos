# Khoregos (χορηγός)

**Verification infrastructure for AI coding agents.**

Khoregos (`k6s`) is a governance layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Agent Teams. It provides HMAC-signed audit trails, agent boundary enforcement, persistent governed workspaces, sensitive change detection, compliance reporting, and observability — without patching or modifying Claude Code internals.

```
Agent Teams  →  Khoregos
```

The agents do the work. Khoregos makes it auditable, attributable, and compliant.

In ancient Greek theatre, the _choregos_ was the citizen who funded what the city-state would not — closing the gaps left unfilled. Khoregos does the same for AI-assisted development.

![sibyllai_khoregos](https://github.com/user-attachments/assets/0836d292-1d34-4c67-9eba-0b9f789872ce)

## The problem

AI coding agents can now generate, refactor, and ship code faster than any team in history. With Claude Code's native Agent Teams, a single developer can run multiple agents working on different parts of a codebase simultaneously.

This creates an accountability gap:

- **Who wrote what?** Multiple agents modify files in parallel. Commit history no longer tells the full story.
- **What got touched?** Agents can modify `.env` files, add dependencies, and alter security-sensitive paths as side effects — with no review step.
- **What happened when it broke?** Without structured logging, debugging a Claude Code run means guessing.
- **Can you prove it to an auditor?** Regulated industries need verifiable evidence of change management, not screenshots.

Khoregos closes this gap.

## Quick start

**Install the CLI:**

```bash
npm install -g @sibyllai/khoregos
```

**Initialize in your project:**

```bash
cd /path/to/your-project
k6s init                              # Default config
k6s init --preset security-strict     # Or pick a preset
k6s init --list-presets               # See all six presets
```

**Start a governed workspace:**

```bash
k6s team start "implement OAuth2 login"
claude "implement OAuth2 login with Google provider"
```

Or combine both steps:

```bash
k6s team start --run "implement OAuth2 login with Google provider"
```

**See what happened:**

```bash
k6s audit show                          # Full event timeline
k6s audit show --severity critical      # Filter by severity
k6s audit show --json                   # Machine-readable events for scripts
k6s audit tail                          # Live-stream events
k6s audit verify --json --exit-code     # Verify chain and gate CI on failure
k6s audit report --session latest       # Generate compliance report
k6s audit report --session latest --json # Structured report payload
k6s compliance checkpoint --json --exit-code # Compliance gate for pipelines
k6s audit export --format json          # Export for downstream tooling
k6s cost show                           # Token usage and cost summary
k6s cost show --by-agent                # Cost breakdown per agent
k6s cost show --by-model --json         # Per-model breakdown (JSON)
k6s audit transcript                    # View stored conversation transcript
k6s audit transcript --role user --json # Filter by role, JSON output
```

**Open the real-time dashboard:**

```bash
k6s dashboard                              # Standalone
k6s team start "implement auth" --dashboard # Or with team start
```

![k6s-dashboard](https://github.com/user-attachments/assets/616aa68b-2366-4193-8182-ebb8999b352a)


The dashboard serves a self-contained HTML page on localhost with SSE-powered live updates — audit trail, cost tracking, agent status, sensitive review items, and conversation transcript in one view.

**Commit the governance record alongside your code:**

```bash
k6s export --session latest --format git --output .governance/
git add .governance/ && git commit -m "governance: add session audit trail"
```

This exports the full audit trail, session metadata, agent records, boundary violations, and a pre-rendered report into `.governance/` — structured files designed for git diffs and PR reviews. Verify the chain from exported data without the local database:

```bash
k6s audit verify --from-export .governance/sessions/01JAB.../  --exit-code
```

For scripts, use JSON output on any structured command:

```bash
k6s --json status
k6s --json team status
k6s --json session list
```

**Resume tomorrow where you left off:**

```bash
k6s team resume
```

## What it captures

Every tool invocation, file modification, and agent lifecycle event is recorded automatically via Claude Code hooks. Here is `k6s audit show` after a governed run:

```
┌──────────┬─────┬───────┬─────────┬──────┬────────────────────────┬───────────────────────────────────────────────┐
│ Time     │ Seq │ Delta │ Agent   │ Sev  │ Type                   │ Action                                        │
├──────────┼─────┼───────┼─────────┼──────┼────────────────────────┼───────────────────────────────────────────────┤
│ 17:29:49 │ 10  │ 5.2s  │ system  │ info │ session_complete       │ claude code session ended                     │
│ 17:29:44 │ 9   │ 51.9s │ primary │ warn │ tool_use               │ tool_use: bash — node index.js &              │
│ 17:28:52 │ 8   │ 17ms  │ primary │ warn │ sensitive_needs_review │ Sensitive file modified: New Dependency App.. │
│ 17:28:52 │ 7   │ 5.1s  │ primary │ info │ tool_use               │ tool_use: edit — package.json                 │
│ 17:28:47 │ 6   │ 7.3s  │ primary │ info │ tool_use               │ tool_use: Read                                │
│ 17:28:40 │ 5   │ 1m57s │ primary │ info │ tool_use               │ tool_use: write — index.js                    │
│ 17:26:43 │ 4   │ 32.7s │ primary │ info │ tool_use               │ tool_use: bash — npm install express          │
│ 17:26:10 │ 3   │ 4.3s  │ primary │ info │ tool_use               │ tool_use: Read                                │
│ 17:26:06 │ 2   │ 11.6s │ primary │ info │ tool_use               │ tool_use: bash — ls -la                       │
│ 17:25:54 │ 1   │ —     │ system  │ info │ session_start          │ session started                               │
└──────────┴─────┴───────┴─────────┴──────┴────────────────────────┴───────────────────────────────────────────────┘
```

The `sensitive_needs_review` warning on seq 8 fired automatically because the agent edited `package.json`, which matches the dependency-approval gate rule. No configuration beyond `k6s init` was required.

## What it provides

- **Audit trail.** Append-only, HMAC-signed, hash-chained event log with agent attribution and severity classification. Tamper-evident by design.
- **Workspace persistence.** Claude Code sessions are ephemeral — when the process exits, the context is gone. Khoregos creates a governed workspace that persists across multiple Claude Code sessions, so your team can resume tomorrow where it left off.
- **Boundary enforcement.** Per-agent file access rules using glob patterns. Advisory mode logs violations; strict mode reverts them via git.
- **Sensitive change detection.** Gate patterns flag modifications to dependency files, secrets, infrastructure configs, and security-sensitive paths.
- **Supply chain visibility.** Automatic detection of dependency additions, removals, and version changes.
- **Git export.** Export a session's governance data as structured, diffable files that travel with the code. Verify the HMAC chain from exported data in CI without the local database.
- **Compliance reporting.** Structured Markdown reports with SOC 2 and ISO 27001 mapping templates.
- **Data classification.** File-level tags (`public`, `internal`, `confidential`, `restricted`) carried through audit events.
- **External timestamping.** RFC 3161 anchors for non-repudiation.
- **Webhook notifications.** HMAC-signed HTTP callbacks with retry backoff.
- **Resource limits.** Per-agent tool call caps with advisory enforcement.
- **Configuration presets.** Six named presets (`minimal`, `security-strict`, `compliance-soc2`, `compliance-iso27001`, `monorepo`, `microservices`) generate a tailored `k6s.yaml` in one command.
- **Plugin system.** ESM plugins with lifecycle and event hooks for custom governance logic.
- **Token usage tracking.** Automatic capture of input/output/cache tokens and estimated costs from Claude Code transcript data. Per-session and per-agent cost breakdowns via `k6s cost show`.
- **Conversation transcript storage.** Configurable storage of full conversation transcripts in SQLite with two-pass PII redaction (regex patterns + NER via [compromise](https://www.npmjs.com/package/compromise)), thinking-block stripping, and content truncation. Three modes: `full`, `usage-only`, `off`. Query via `k6s audit transcript`.
- **Real-time dashboard.** Built-in HTTP server with SSE live updates. Audit trail table, cost summary, agent cards, sensitive review panel, conversation transcript, and event timeline — all in one self-contained page. Launch with `k6s dashboard` or `k6s team start --dashboard`.
- **Observability.** OpenTelemetry traces, Prometheus metrics endpoint, OTLP export, Langfuse LLM observability (opt-in). Token usage counters (`k6s_input_tokens_total`, `k6s_output_tokens_total`, `k6s_token_cost_usd_total`).
- **File locking.** SQLite-based exclusive locks to prevent multi-agent edit collisions.

## How it works (without patching Claude Code)

Khoregos uses two integration surfaces, both public and stable:

1. **MCP server** — Agents connect via the Model Context Protocol and call governance tools voluntarily. This is the cooperative channel.
2. **Claude Code hooks** — Claude Code's lifecycle hooks (`post-tool-use`, `subagent-start/stop`, `stop`) capture every action regardless of agent compliance. This is the safety net.

`k6s team start` registers hooks and the MCP server in `.claude/settings.json`. Governance does not depend on agent cooperation. Even if an agent ignores MCP tools entirely, the hook-based audit trail captures everything.

> **Coming soon: Claude Code plugin.** A native plugin is pending review in the Claude Code marketplace. Once approved, it will package hooks, MCP server, governance skill, and slash commands into a two-command install — replacing the manual registration step. Until then, `k6s team start` handles registration automatically.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  k6s CLI  ───►  GOVERNANCE ENGINE                            │
│                 Audit · Boundaries · State · Locks · Signing │
│                 Severity · Events · Telemetry                │
│                 SQLite (.khoregos/k6s.db)                    │
├──────────────────────────────────────────────────────────────┤
│         MCP Server              Filesystem Watcher           │
├──────────────────────────────────────────────────────────────┤
│              CLAUDE CODE AGENT TEAMS                         │
│  Lead ──► Teammate 1 ──► Teammate 2 ──► Teammate N           │
│  Hook events: post-tool-use, subagent-start/stop, stop       │
├──────────────────────────────────────────────────────────────┤
│  Dashboard (SSE) │  OpenTelemetry │  Prometheus │  Langfuse │  Webhooks │
└──────────────────────────────────────────────────────────────┘
```

**Stack:** TypeScript (strict, ESM), Node.js 18+, SQLite via better-sqlite3, Commander.js, Zod, picomatch, chokidar, @opentelemetry/\*, langfuse.

## Who this is for

| You are...                                                     | You care about...                                  | Khoregos gives you...                                           |
| -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| **Enterprise dev team**                                        | Compliance, accountability, audit evidence         | HMAC-signed trails, compliance reports, workspace persistence   |
| **DevSecOps engineer**                                         | Integrating AI agents into security pipelines      | OpenTelemetry export, Prometheus metrics, Langfuse, webhooks    |
| **Regulated industry** (finance, healthcare, government, NGOs) | Provenance, change management, defensible evidence | Audit export, boundary enforcement, data classification         |
| **Platform team**                                              | Standardization across developers and projects     | Configuration-driven governance, MCP integration, plugin system |
| **Individual developer**                                       | Understanding what agents actually did             | `k6s audit show`, `k6s audit tail`, workspace history           |

## Configuration

`k6s.yaml` controls everything: project metadata, retention policies, per-agent boundary rules, data classifications, gate patterns, and observability settings. `k6s init` generates sensible defaults that flag `.env*`, `*.pem`, `*.key`, and dependency files out of the box. For faster setup, use `k6s init --preset <name>` to generate a config tuned for your use case — from solo experiments (`minimal`) to SOC 2 audit prep (`compliance-soc2`) to multi-package repos (`monorepo`).

## Documentation

Full documentation lives in the [wiki](https://github.com/sibyllai/khoregos/wiki): architecture internals, CLI reference, configuration guide, compliance mappings, and operational playbooks.

## License

MIT

---

Built by [Sibyllai](https://github.com/sibyllai). Part of the Sibyllai AI tools series.
