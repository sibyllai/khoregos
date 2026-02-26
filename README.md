# Khoregos

Khoregos (`k6s`) is a governance layer for Claude Code Agent Teams. It gives organizations durable auditability, operational controls, and evidence trails for AI-assisted development.

## Why Khoregos now

At the age of AI coding and vibe coding, teams can ship faster than ever, but speed without governance becomes legal and operational risk.

- AI-generated changes can be difficult to attribute without a reliable session and agent trail.
- Security-sensitive files can be touched quickly without clear review evidence.
- Legal, compliance, and internal audit teams need verifiable records, not screenshots or ad hoc logs.
- Governance must work with AI tooling, not by patching it or breaking developer flow.

Khoregos is built for this gap: structured, signed, queryable evidence for what happened, who did it, and when.

## What it provides today

- **Audit trail.** Append-only session events with agent attribution, severity, and export options.
- **Session governance.** Start, stop, and resume governed agent sessions with preserved context.
- **Boundary controls.** Allowed/forbidden path rules with violation tracking.
- **Collaboration safety.** File lock primitives to reduce multi-agent edit collisions.
- **Sensitive change annotations.** Gate-style markers for files that need human review.
- **Observability.** OpenTelemetry support and Prometheus metrics endpoint.
- **MCP integration.** Native governance tools exposed through MCP, with automatic project wiring.

## Quick start

1. **Install Khoregos once on your machine.**

```bash
cd khoregos
npm install
npm run build
npm link
```

2. **Initialize governance in your project.**

```bash
cd /path/to/your-project
k6s init
```

3. **Start a governed Claude work session.**

```bash
k6s team start "build feature x with governance"
claude "implement feature x"
```

Or launch Claude directly from Khoregos:

```bash
k6s team start --run "implement feature x"
```

4. **Inspect what happened and export evidence.**

```bash
k6s audit show
k6s audit show --severity critical
k6s audit export --format json
```

5. **Optionally plug observability tooling.**

If you enable observability settings in `k6s.yaml`, Khoregos can emit OpenTelemetry data and expose a Prometheus metrics endpoint for dashboards and alerting.

6. **Stop or resume when your team pauses work.**

```bash
k6s team stop
k6s team resume
```

## What you can configure in k6s.yaml

- **Project metadata.** Project identity and session defaults.
- **Session retention.** Context and audit retention windows.
- **Boundaries.** Per-agent allowed and forbidden path patterns with enforcement mode.
- **Gates and sensitive patterns.** File pattern triggers that generate review-oriented audit annotations.
- **Observability.** OpenTelemetry endpoint settings and Prometheus endpoint settings.
- **Webhooks.** Event-driven outbound notifications for governance workflows.

## Why this matters for legal and compliance teams

Khoregos is designed to make AI development reviewable and defensible.

- It produces machine-readable evidence that can be retained, filtered, and exported.
- It supports post-hoc control workflows where regulatory review is required.
- It aligns with roadmap items aimed at legislation-ready reporting for audit and compliance programs.

## Roadmap snapshot

Upcoming and next-phase priorities:

- **Phase 4.** Strict enforcement, plugin architecture, and stronger supply-chain controls.
- **Phase 5.** Compliance-ready reporting workflows, standards-oriented report generation, and checkpoint tooling.
- **Phase 6.** Enterprise platform capabilities such as RBAC, SSO, and PostgreSQL-backed deployment models.

Near-term roadmap items include dashboard maturity, webhook integrations, and continued observability hardening.

## Documentation scope

This README is intentionally concise. A full, comprehensive wiki will cover deep configuration, architecture internals, compliance mappings, and operational playbooks.

## License

MIT
