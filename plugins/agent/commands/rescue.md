---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Agent rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [what Agent should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `agent:agent-rescue` subagent.
The final user-visible response must be Agent's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `agent:agent-rescue` subagent in the background.
- If the request includes `--wait`, run the `agent:agent-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Agent, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.js" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Agent thread or start a new one.
- The two choices must be:
  - `Continue current Agent thread`
  - `Start a new Agent thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Agent thread (Recommended)` first.
- Otherwise put `Start a new Agent thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.js" task ...` and return that command's stdout as-is.
- Return the Agent companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/agent:status`, fetch `/agent:result`, call `/agent:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Agent is missing or unauthenticated, stop and tell the user to run `/agent:setup`.
- If the user did not supply a request, ask what Agent should investigate or fix.
