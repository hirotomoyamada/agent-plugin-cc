# Multi-AI plugins for Claude Code

Use **Cursor Agent**, **OpenAI Codex**, or **Moonshot Kimi** from inside Claude Code for code reviews or to delegate tasks. Each provider ships as its own plugin, but all three expose the same slash command surface so you can pick the underlying AI per task without re-learning the workflow.

## What You Get

Three plugins, each with the same command set under its own prefix:

| Command                          | What it does                                                  |
| -------------------------------- | ------------------------------------------------------------- |
| `/<provider>:setup`              | Check the CLI is installed, authenticated, manage review gate |
| `/<provider>:review`             | Read-only code review against local git state                 |
| `/<provider>:adversarial-review` | Steerable challenge review with optional focus text           |
| `/<provider>:rescue`             | Delegate a coding task via the rescue subagent                |
| `/<provider>:status`             | Show running and recent jobs                                  |
| `/<provider>:result`             | Show the stored final output of a finished job                |
| `/<provider>:cancel`             | Cancel an active background job                               |

Replace `<provider>` with `agent`, `codex`, or `kimi`.

## Requirements

| Plugin  | CLI         | How to install                                                                                |
| ------- | ----------- | --------------------------------------------------------------------------------------------- |
| `agent` | `agent` CLI | Install Cursor IDE from https://www.cursor.com                                                |
| `codex` | `codex` CLI | `npm install -g @openai/codex` (see https://github.com/openai/codex)                          |
| `kimi`  | `kimi` CLI  | `pip install kimi-cli` or `uv tool install kimi-cli` (https://moonshotai.github.io/kimi-cli/) |

Plus:

- **Node.js 24.14 or later**

You only need the CLI for the plugin(s) you actually use.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add hirotomoyamada/agent-plugin-cc
```

Install one or more plugins:

```bash
/plugin install agent@agent
/plugin install codex@agent
/plugin install kimi@agent
```

Reload plugins:

```bash
/reload-plugins
```

Then run setup for each plugin you installed:

```bash
/agent:setup
/codex:setup
/kimi:setup
```

Setup tells you whether the underlying CLI is ready. If the binary is missing or not authenticated, it points you at the install or login step for that specific provider.

After install, you should see:

- the slash commands listed above for each installed plugin
- the `<provider>:<provider>-rescue` subagent in `/agents` for each installed plugin

One simple first run is:

```bash
/agent:review --background
/agent:status
/agent:result
```

(Substitute `codex` or `kimi` for `agent` to try the other providers.)

## Choosing a provider

The three plugins are interchangeable from a workflow standpoint. Differences:

- **`agent`** — wraps the Cursor Agent app server. Best if you already use Cursor IDE; reuses your Cursor authentication and config. Tasks can be resumed inside Cursor.
- **`codex`** — wraps the OpenAI Codex CLI. Best if you have a Codex / ChatGPT-Plus account or an OpenAI API key.
- **`kimi`** — wraps the Moonshot Kimi CLI (`kimi --wire`). Best if you want a Moonshot-hosted model and have a `KIMI_API_KEY` / `MOONSHOT_API_KEY`.

You can install all three and pick per task.

## Usage

The command surface is identical across providers. The examples below use `/agent:`; substitute `/codex:` or `/kimi:` to drive a different backend.

### `/<provider>:review`

Runs a normal read-only review on your current work.

> [!NOTE]
> Multi-file reviews can take a while. Prefer `--background`.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Supports `--base <ref>`, `--wait`, and `--background`. It is not steerable and does not take custom focus text. Use [`/<provider>:adversarial-review`](#provideradversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/agent:review
/codex:review --base main
/kimi:review --background
```

This command is read-only. When run in the background you can use [`/<provider>:status`](#providerstatus) to check progress and [`/<provider>:cancel`](#providercancel) to stop it.

### `/<provider>:adversarial-review`

Runs a **steerable** review that challenges the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

Uses the same review target selection as `/<provider>:review`, including `--base <ref>`. Also supports `--wait` and `--background`. Unlike `review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/agent:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/kimi:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only.

### `/<provider>:rescue`

Hands a task to the provider through the `<provider>:<provider>-rescue` subagent.

Use it when you want the provider to:

- investigate a bug
- try a fix
- continue a previous task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model, rescue tasks can run a long time. Prefer `--background` or move the agent to the background.

Supports `--background`, `--wait`, `--resume`, `--resume-id <threadId>`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Use `--resume-id <threadId>` to resume a specific thread by ID. This is useful when managing multiple concurrent threads (e.g., parallel PR reviews) where `--resume` would pick the wrong thread.

Examples:

```bash
/agent:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/kimi:rescue --resume apply the top fix from the last run
/agent:rescue --resume-id thread_abc123 continue from the specific thread
/codex:rescue --model <model> investigate the flaky integration test
/kimi:rescue --background investigate the regression
```

You can also just ask for a task to be delegated, naming the provider in plain text:

```text
Ask Kimi to redesign the database connection to be more resilient.
```

Notes:

- if you do not pass `--model`, the provider chooses its own defaults.
- follow-up rescue requests can continue the latest task in the repo.

### `/<provider>:status`

Shows running and recent jobs for the current repository.

Examples:

```bash
/agent:status
/codex:status task-abc123
/kimi:status --all
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/<provider>:result`

Shows the final stored output for a finished job.

Examples:

```bash
/agent:result
/codex:result task-abc123
```

### `/<provider>:cancel`

Cancels an active background job.

Examples:

```bash
/agent:cancel
/kimi:cancel task-abc123
```

### `/<provider>:setup`

Checks whether the underlying CLI is installed and authenticated. Points you at the right install / login command for the provider when something is missing.

You can also use `setup` to manage the optional review gate per provider.

#### Enabling review gate

```bash
/agent:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted adversarial review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/provider loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session. The review gate is per-provider, so you can have it on for `agent` and off for `kimi`.

## Typical Flows

### Review Before Shipping

```bash
/agent:review
```

### Hand A Problem To A Provider

```bash
/codex:rescue investigate why the build is failing in CI
```

### Use Two Providers Side-By-Side

```bash
/agent:adversarial-review --background look for design issues
/kimi:rescue --background propose a refactor
/agent:status
/kimi:status
```

### Start Something Long-Running

```bash
/agent:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agent:status
/codex:result
```

## How it works

Each plugin wraps the matching CLI's app-server / wire protocol:

- `agent` — JSON-RPC over `agent app-server`
- `codex` — JSON-RPC over `codex app-server`
- `kimi` — JSON-RPC 2.0 (protocol v1.10) over `kimi --wire`

A small Unix-socket broker multiplexes concurrent foreground/background requests so a single CLI process can serve them. The shared code that runs the broker, tracks jobs, renders output, and resolves review targets lives under `src/core/` and is included in every plugin's build.

See [CLAUDE.md](./CLAUDE.md) for the full architecture.

## FAQ

### Do I need an account for every provider?

No. Install only the plugin(s) for the AI(s) you want to use. Each plugin's `/<provider>:setup` command tells you what credentials it needs (Cursor login for `agent`, OpenAI / ChatGPT-Plus for `codex`, `KIMI_API_KEY` for `kimi`).

### Do the plugins share state?

No. Each plugin has its own jobs, status, broker session, and review gate config. `/agent:status` only shows agent jobs; `/kimi:status` only shows kimi jobs.

### Can I run them at the same time?

Yes. Each plugin has its own broker and job index, so you can have, for example, a `/agent:adversarial-review --background` and a `/kimi:rescue --background` running concurrently in the same repo.

### Will it use my existing CLI config?

Yes. Each plugin delegates through the locally installed CLI on the same machine, using whatever model / config / login state that CLI is already set up with.
