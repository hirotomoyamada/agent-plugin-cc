---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Kimi rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [what Kimi should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `kimi:kimi-rescue` subagent.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `kimi:kimi-rescue` subagent in the background.
- If the request includes `--wait`, run the `kimi:kimi-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Kimi, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.js" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Kimi thread or start a new one.
- The two choices must be:
  - `Continue current Kimi thread`
  - `Start a new Kimi thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Kimi thread (Recommended)` first.
- Otherwise put `Start a new Kimi thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.js" task ...` and return that command's stdout as-is.
- Return the Kimi companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/kimi:status`, fetch `/kimi:result`, call `/kimi:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Kimi is missing or unauthenticated, stop and tell the user to run `/kimi:setup`.
- If the user did not supply a request, ask what Kimi should investigate or fix.
