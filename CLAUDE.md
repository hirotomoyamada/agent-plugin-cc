# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code plugin that integrates Cursor Agent for code review and task delegation. The plugin exposes slash commands (`/agent:setup`, `/agent:review`, `/agent:rescue`, etc.) that let Claude Code users run reviews or delegate coding tasks to Cursor Agent.

## Commands

- `pnpm install` — install dependencies
- `pnpm build` — compile TypeScript (`src/` → `plugins/agent/scripts/`)
- `pnpm typecheck` — type-check without emitting
- `pnpm lint` — run Biome linter
- `pnpm check` — run Biome lint + format check
- `pnpm format` — run Biome formatter

## Architecture

### Build pipeline

TypeScript sources live in `src/`. The compiler outputs to `plugins/agent/scripts/` (the plugin's runtime directory). The `plugins/agent/` tree is the deployed plugin artifact that Claude Code loads.

### Entry points

- **`src/agent-companion.ts`** — Main CLI. Dispatches subcommands: `setup`, `review`, `adversarial-review`, `task`, `status`, `result`, `cancel`. Each subcommand can run foreground or background, with optional JSON output (`--json`).
- **`src/app-server-broker.ts`** — JSON-RPC broker over Unix domain sockets. Multiplexes concurrent clients against a single `AgentAppServerClient` connection, serializing streaming turns and routing notifications to the owning socket.

### Core libraries (`src/lib/`)

- **`app-server.ts`** — `AgentAppServerClient`: manages the JSON-RPC connection to Cursor's app server (direct or via broker). Handles initialization, request/response, and notification routing.
- **`agent.ts`** — High-level Agent operations: `runAppServerTurn`, `runAppServerReview`, thread management, structured output parsing, auth/availability checks.
- **`broker-lifecycle.ts` / `broker-endpoint.ts`** — Broker process lifecycle (spawn, health-check, session persistence) and endpoint address parsing (Unix socket paths).
- **`state.ts`** — Persistent config and job index stored as JSON files under a workspace `.agent-companion/` directory.
- **`job-control.ts`** — Job lookup, status snapshots, and resolution helpers for the `status`/`result`/`cancel` commands.
- **`tracked-jobs.ts`** — Job execution wrapper that tracks start/completion, writes log files, and updates progress.
- **`render.ts`** — Formats payloads into human-readable CLI output (setup reports, review results, status tables).
- **`git.ts`** — Git helpers: review target resolution, diff collection, branch detection.
- **`prompts.ts`** — Loads and interpolates Markdown prompt templates from `plugins/agent/prompts/`.

### Plugin structure (`plugins/agent/`)

- `commands/` — Slash command definitions (Markdown files describing each command)
- `agents/` — Agent definitions (e.g., `agent-rescue.md`)
- `hooks/` — Hook definitions (`hooks.json`)
- `prompts/` — Prompt templates used by adversarial review and stop-review gate
- `schemas/` — JSON schemas for structured review output
- `skills/` — Skill definitions for Claude Code

## Code Style

- Biome handles linting and formatting: indent with 2 spaces, double quotes, semicolons, no trailing commas, 120 char line width
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint via lefthook)
- Pre-commit hook runs `biome check --write` on staged files
- Node ≥ 24.14, pnpm 10.x
