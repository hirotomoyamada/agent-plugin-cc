# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Monorepo that ships three Claude Code plugins, each integrating a different external AI coding CLI:

- **`agent`** — Cursor Agent (`agent app-server` JSON-RPC)
- **`codex`** — OpenAI Codex (`codex app-server` JSON-RPC)
- **`kimi`** — Moonshot Kimi (`kimi --wire` JSON-RPC 2.0, protocol v1.10)

All three plugins expose the same slash command surface (`/<provider>:setup`, `/<provider>:review`, `/<provider>:adversarial-review`, `/<provider>:rescue`, `/<provider>:status`, `/<provider>:result`, `/<provider>:cancel`), so users can pick the underlying AI per task without re-learning the workflow.

## Commands

- `pnpm install` — install dependencies
- `pnpm build` — compile all three plugins (agent + codex + kimi)
- `pnpm build:agent` / `pnpm build:codex` / `pnpm build:kimi` — compile one provider at a time
- `pnpm typecheck` — type-check every tsconfig without emitting
- `pnpm lint:check` — run oxlint (`--max-warnings=0`)
- `pnpm lint:fix` — run oxlint with `--fix`
- `pnpm format:check` — check formatting with oxfmt
- `pnpm format:write` — apply formatting with oxfmt
- `pnpm clean` — remove all build outputs and `node_modules`

Each `pnpm build:<provider>` is two tsgo invocations: one for the provider-specific source (`src/<provider>/` → `plugins/<provider>/scripts/`), one for the shared core (`src/core/` → `plugins/<provider>/core/`). The core copy is duplicated into every plugin so each artifact is self-contained at install time.

## Architecture

### Provider-shared core (`src/core/lib/`)

Everything that does not need to know which CLI is being driven lives here. Modules take a `ProviderContext` parameter so they can be bound per provider:

- **`provider.ts`** — `ProviderContext` type: id, displayName, slash prefix, CLI binary, CLI args, env-var names, state directory names, broker session prefixes, app-server client title, etc.
- **`app-server.ts`** — `AppServerClientBase` (generic JSON-RPC over stdio transport), `SpawnedAppServerClient`, `BrokerAppServerClient`, and `connectAppServer()`. The transport is provider-agnostic; only the spawn binary, args, and env var names come from `ProviderContext`. The base class exposes `setNotificationHandler` and `setServerRequestHandler` so providers can hook in their RPC semantics.
- **`app-server-broker.ts`** — `runBrokerMain(options)`: generic Unix-socket broker that multiplexes client connections against one upstream `AppServerClientBase`. Providers pass their own `streamingMethods`, `interruptMethod`, `streamCompletedMethod`, etc.
- **`state.ts`** — Persistent config and job index stored as JSON files under a workspace `.<provider>-companion/` directory.
- **`broker-lifecycle.ts` / `broker-endpoint.ts`** — Broker process lifecycle and Unix socket address parsing.
- **`job-control.ts`** — Job lookup, status snapshots, and resolution helpers for `status`/`result`/`cancel`. Provider-specific runtime status injected via callback.
- **`tracked-jobs.ts`** — Job execution wrapper that tracks start/completion, writes log files, and updates progress.
- **`render.ts`** — Formats payloads into human-readable CLI output (setup reports, review results, status tables) — parameterized by display name and slash prefix.
- **`git.ts`** — Git helpers: review target resolution, diff collection, branch detection.
- **`prompts.ts`** — Loads and interpolates Markdown prompt templates from `plugins/<provider>/prompts/`.
- **`structured-output.ts`** — `parseStructuredOutput` / `readOutputSchema` / `extractJsonFromText`.
- **`args.ts`** / **`fs.ts`** / **`process.ts`** / **`strings.ts`** / **`workspace.ts`** — small utilities.

### Per-provider source (`src/<provider>/`)

Each provider directory has:

- **`<provider>-companion.ts`** — Main CLI. Dispatches subcommands: `setup`, `review`, `adversarial-review`, `task`, `task-worker`, `task-resume-candidate`, `status`, `result`, `cancel`. Each can run foreground or background, with optional JSON output (`--json`).
- **`app-server-broker.ts`** — Entry-point script that calls `runBrokerMain()` from core with the provider's streaming-method set.
- **`session-lifecycle-hook.ts`** — Cleans up broker session and stops any running jobs on `SessionEnd`.
- **`stop-review-gate-hook.ts`** — Runs an adversarial review on `Stop` when the gate is enabled.
- **`lib/<provider>.ts`** — Provider-specific operations: availability/auth check, `runTurn`, `runReview`, `interruptTurn`, `getSessionRuntimeStatus`, thread tracking. Different per provider because each CLI exposes a different RPC dialect (e.g., Kimi uses `prompt`/`cancel`/`event` notifications, Cursor Agent uses `turn/start`/`review/start`/`turn/completed`).
- **`lib/provider-config.ts`** — The `ProviderContext` instance for that provider.
- **`lib/app-server.ts`** — Provider-specific `XxxAppServerClient.connect()` factory that wraps `connectAppServer()` from core and sends the `initialize` RPC with the right payload shape.
- **`lib/<file>.ts` (state / render / job-control / tracked-jobs / broker-lifecycle / broker-endpoint / fs / args / git / process / prompts / strings / workspace)** — Thin shims that import the core function and bind it to the provider's config.

### Plugin artifacts (`plugins/<provider>/`)

The deployed plugin tree that Claude Code loads:

- `.claude-plugin/plugin.json` — Plugin manifest
- `commands/` — Slash command definitions (Markdown files)
- `agents/` — Agent definitions (e.g., `<provider>-rescue.md`)
- `hooks/hooks.json` — `SessionStart`/`SessionEnd`/`Stop` hooks
- `prompts/` — Prompt templates for adversarial review and stop-review gate
- `schemas/` — JSON schemas for structured review output
- `skills/` — Skill definitions (`<provider>-cli-runtime`, `<provider>-prompting`, `<provider>-result-handling`)
- `scripts/` — Compiled provider source (from `src/<provider>/`)
- `core/` — Compiled shared core (from `src/core/`)

### Marketplace

[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) lists all three plugins, each pointing at its own `plugins/<provider>` directory.

## Adding a new provider

The provider pattern is intentionally repetitive so new ones can be cloned in:

1. Create `src/<provider>/lib/provider-config.ts` with a `ProviderContext`.
2. Mirror the lib shim files from one of the existing providers (`state.ts`, `render.ts`, `job-control.ts`, `tracked-jobs.ts`, `broker-endpoint.ts`, `broker-lifecycle.ts`, `app-server.ts`, `fs.ts`, plus the pure re-exports for `args`/`git`/`process`/`prompts`/`strings`/`workspace`).
3. Write `src/<provider>/lib/<provider>.ts` with the provider-specific RPC logic (availability check, `runTurn`, `runReview`, `interruptTurn`, `getSessionRuntimeStatus`, thread tracking).
4. Write `src/<provider>/<provider>-companion.ts` (the dispatcher) and `src/<provider>/app-server-broker.ts` (calls `runBrokerMain()` with the provider's streaming methods).
5. Copy hooks, prompts, schemas, skills, commands, and the rescue agent from an existing plugin; replace branding strings.
6. Add `tsconfig.<provider>.json` and `tsconfig.<provider>-core.json`, update `package.json` build scripts, and register the plugin in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

## Code Style

- oxlint handles linting (`pnpm lint:check` / `pnpm lint:fix`); oxfmt handles formatting (`pnpm format:check` / `pnpm format:write`)
- Type checking uses tsgo (TypeScript native preview); both `pnpm build` and `pnpm typecheck` invoke it
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint via lefthook)
- Pre-commit hook runs oxlint + oxfmt on staged files
- Node ≥ 24.14, pnpm 10.x

### Known build quirk

tsgo follows imports across the rootDir boundary and emits `.js` files into `src/core/lib/` when compiling a provider's source. These leaked outputs are git-ignored (`src/**/*.js`) and excluded from lint/format. They do not affect plugin artifacts.
