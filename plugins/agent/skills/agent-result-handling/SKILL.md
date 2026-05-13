---
name: agent-result-handling
description: Internal guidance for presenting Agent helper output back to the user
user-invocable: false
---

# Agent Result Handling

When the helper returns Agent output:

- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Agent marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Agent made edits, say so explicitly and list the touched files when the helper provides them.
- For `agent:agent-rescue`, do not turn a failed or incomplete Agent run into a Claude-side implementation attempt. Report the failure and stop.
- For `agent:agent-rescue`, if Agent was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Agent run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/agent:setup` and do not improvise alternate auth flows.
