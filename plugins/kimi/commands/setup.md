---
description: Check whether the local Kimi CLI is ready and optionally toggle the stop-time review gate
argument-hint: "[--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash(node:*), Bash(pip:*), Bash(uv:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.js" setup --json $ARGUMENTS
```

If the result says Kimi is unavailable:

- Tell the user to install with `pip install kimi-cli` (or `uv tool install kimi-cli`).
- Reference docs: https://moonshotai.github.io/kimi-cli/

If Kimi is installed but not authenticated:

- Tell the user to export `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) in their shell.
- Suggest checking https://platform.moonshot.ai for a key.

Output rules:

- Present the final setup output to the user.
