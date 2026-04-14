# Agent plugin for Claude Code

Use Cursor Agent from inside Claude Code for code reviews or to delegate tasks to Agent.

This plugin is for Claude Code users who want an easy way to start using Cursor Agent from the workflow
they already have.

## What You Get

- `/agent:review` for a normal read-only Agent review
- `/agent:adversarial-review` for a steerable challenge review
- `/agent:rescue`, `/agent:status`, `/agent:result`, and `/agent:cancel` to delegate work and manage background jobs

## Requirements

- **Cursor IDE with the `agent` CLI.**
  - Install Cursor from https://www.cursor.com to get the `agent` CLI.
- **Node.js 24.14 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add hirotomoyamada/agent-plugin-cc
```

Install the plugin:

```bash
/plugin install agent@cursor-agent
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/agent:setup
```

`/agent:setup` will tell you whether Agent is ready. If the `agent` CLI is missing, it will tell you to install Cursor IDE.

If Cursor is installed but not logged in yet, run:

```bash
!agent login
```

After install, you should see:

- the slash commands listed below
- the `agent:agent-rescue` subagent in `/agents`

One simple first run is:

```bash
/agent:review --background
/agent:status
/agent:result
```

## Usage

### `/agent:review`

Runs a normal Agent review on your current work. It gives you the same quality of code review as running a review inside Cursor Agent directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/agent:adversarial-review`](#agentadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/agent:review
/agent:review --base main
/agent:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/agent:status`](#agentstatus) to check on the progress and [`/agent:cancel`](#agentcancel) to cancel the ongoing task.

### `/agent:adversarial-review`

Runs a **steerable** review that challenges the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/agent:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/agent:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/agent:adversarial-review
/agent:adversarial-review --base main challenge whether this was the right caching and retry design
/agent:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/agent:rescue`

Hands a task to Agent through the `agent:agent-rescue` subagent.

Use it when you want Agent to:

- investigate a bug
- try a fix
- continue a previous Agent task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/agent:rescue investigate why the tests started failing
/agent:rescue fix the failing test with the smallest safe patch
/agent:rescue --resume apply the top fix from the last run
/agent:rescue --model <model> investigate the flaky integration test
/agent:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Agent:

```text
Ask Agent to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, Agent chooses its own defaults.
- follow-up rescue requests can continue the latest Agent task in the repo

### `/agent:status`

Shows running and recent Agent jobs for the current repository.

Examples:

```bash
/agent:status
/agent:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/agent:result`

Shows the final stored Agent output for a finished job.

Examples:

```bash
/agent:result
/agent:result task-abc123
```

### `/agent:cancel`

Cancels an active background Agent job.

Examples:

```bash
/agent:cancel
/agent:cancel task-abc123
```

### `/agent:setup`

Checks whether Cursor Agent is installed and authenticated.
If the `agent` CLI is missing, it will tell you to install Cursor IDE.

You can also use `/agent:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/agent:setup --enable-review-gate
/agent:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Agent review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Agent loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/agent:review
```

### Hand A Problem To Agent

```bash
/agent:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/agent:adversarial-review --background
/agent:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agent:status
/agent:result
```

## Agent Integration

The Agent plugin wraps the Cursor Agent app server. It uses the `agent` CLI from your Cursor IDE installation.

### Moving The Work Over To Cursor

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Cursor Agent. This way you can review the Agent work or continue the work there.

## FAQ

### Do I need a separate Cursor account for this plugin?

If you are already signed into Cursor on this machine, that account should work immediately here too. This plugin uses your local Cursor authentication.

If you only use Claude Code today and have not used Cursor yet, you will also need to sign in to Cursor. Run `/agent:setup` to check whether Agent is ready, and use `!agent login` if it is not.

### Does the plugin use a separate Agent runtime?

No. This plugin delegates through your local Cursor Agent CLI and app server on the same machine.

That means:

- it uses the same Cursor install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Cursor config I already have?

Yes. If you already use Cursor, the plugin picks up the same configuration.
