---
description: Check whether the local Cursor Agent CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.js" setup --json $ARGUMENTS
```

If the result says Cursor Agent is unavailable:
- Tell the user to install Cursor IDE from https://www.cursor.com to get the `agent` CLI.
- Do not attempt to install it via npm.

If Cursor Agent is already installed but not authenticated:
- Preserve the guidance to run `!agent login`.

Output rules:
- Present the final setup output to the user.
