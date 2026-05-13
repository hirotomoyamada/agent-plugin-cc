---
description: Show active and recent Kimi jobs for this repository
argument-hint: "[job-id] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.js" status "$ARGUMENTS"`

If the user did not pass a job ID:

- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve actionable fields: job ID, kind, status, phase, elapsed/duration, summary, follow-up commands.

If the user did pass a job ID:

- Present the full command output to the user.
- Do not summarize or condense it.
