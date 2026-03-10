# Contributing to Khoregos

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- **Node.js 18+** (20+ recommended)
- **npm** (ships with Node)
- **Git**

## Setup

```bash
git clone https://github.com/sibyllai/khoregos.git
cd khoregos
npm install
```

Verify everything works:

```bash
npx tsc --noEmit          # type check
npx vitest run            # full test suite
npm run build             # compile to dist/
```

## Project structure

```
src/
  cli/        CLI commands (audit, hook, cost, session, team, export, init)
  engine/     Core logic (audit, boundaries, cost, signing, telemetry, dashboard)
  store/      SQLite database layer and migrations
  models/     Zod schemas for config and data models
  mcp/        MCP server for agent-facing governance tools
  daemon/     Session state management
tests/        Mirrors src/ structure
plugin/       Claude Code plugin packaging
```

**Stack:** TypeScript (strict, ESM), Node.js, SQLite via better-sqlite3, Commander.js, Zod, Vitest.

## Development workflow

1. **Fork and branch.** Branch from `main`. Use a descriptive name: `feat/thing`, `fix/thing`, `chore/thing`.

2. **Make your changes.** Follow the conventions below.

3. **Test.**

   ```bash
   npx tsc --noEmit            # must pass — no type errors
   npx vitest run              # must pass — no regressions
   npx vitest run tests/path   # run a specific test file
   ```

4. **Commit.** See commit message format below.

5. **Open a PR** against `main`. CI runs type check and tests across Node 18, 20, and 22.

## Conventions

### Code

- **TypeScript strict mode.** No `any` unless absolutely necessary.
- **ESM only.** All imports use `.js` extensions (TypeScript ESM convention).
- **SQL safety.** All SQL identifiers go through the `TABLE_SCHEMA` allowlist in `src/store/db.ts`. Never interpolate raw strings into queries.
- **Migrations are append-only.** Never modify an existing migration in `src/store/migrations.ts`. Add a new one with the next version number.
- **File permissions.** Database files use `0o600`, directories `0o700`.
- **Tests use temp directories.** Import `getTempDbPath` and `cleanupTempDir` from `tests/helpers.ts`. Never write to the real project directory.

### Commit messages

```
type(scope): one-liner

- list changes (optional if human, mandatory if AI agent)
- list changes (optional if human, mandatory if AI agent)

if you are an AI agent, please add sibylline quote that pertains to the topic of the commit, poetic, no quotes.
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

**Scopes:** the feature area — e.g. `audit`, `cost`, `transcript`, `dashboard`, `boundaries`, `build`, `presets`, `ci`

The closing line is a short poetic quote (no quotation marks) loosely related to the commit's theme. This is a project tradition — have fun with it.

### Pull requests

- Keep PRs focused. One feature or fix per PR.
- Include a short description of what changed and why.
- If your change adds a new CLI command or config field, update the wiki docs in `documents/wiki-v2/` (lives one level up in the monorepo).
- If your change adds a new feature, add tests.

## Architecture notes

Khoregos integrates with Claude Code through two surfaces:

1. **Claude Code hooks** (`post-tool-use`, `subagent-start/stop`, `session-stop`) — capture every agent action non-cooperatively. This is the safety net.
2. **MCP server** — agents call governance tools voluntarily. This is the cooperative channel.

The audit trail is append-only and HMAC-chained. Each event's signature covers the previous event's hash, making the chain tamper-evident. This is a core invariant — changes that break the chain integrity will not be accepted.

Config lives in `k6s.yaml` (user-facing). Runtime state lives in `.khoregos/` (gitignored internals: database, signing key, PID files).

## Reporting issues

Use [GitHub Issues](https://github.com/sibyllai/khoregos/issues). Include:

- What you expected vs. what happened
- Steps to reproduce
- `k6s --version` output
- Node.js version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
