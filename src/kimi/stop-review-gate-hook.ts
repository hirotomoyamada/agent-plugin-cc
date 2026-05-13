import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { sortJobsNewestFirst } from "./lib/job-control.js"
import { getKimiAvailability } from "./lib/kimi.js"
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.js"
import { getConfig, type JobRecord, listJobs } from "./lib/state.js"
import { coerceString } from "./lib/strings.js"
import { SESSION_ID_ENV } from "./lib/tracked-jobs.js"
import { resolveWorkspaceRoot } from "./lib/workspace.js"

interface HookInput {
  [key: string]: unknown
  cwd?: string
  last_assistant_message?: string
  session_id?: string
}

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..")
const _STOP_REVIEW_TASK_MARKER =
  "Run a stop-gate review of the previous Claude turn."

function readHookInput(): HookInput {
  const raw = fs.readFileSync(0, "utf8").trim()
  if (!raw) {
    return {}
  }
  return JSON.parse(raw) as HookInput
}

function emitDecision(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function logNote(message: null | string | undefined): void {
  if (!message) {
    return
  }
  process.stderr.write(`${message}\n`)
}

function filterJobsForCurrentSession(
  jobs: JobRecord[],
  input: HookInput = {},
): JobRecord[] {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null
  if (!sessionId) {
    return jobs
  }
  return jobs.filter((job) => job.sessionId === sessionId)
}

function buildStopReviewPrompt(input: HookInput = {}): string {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim()
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate")
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : ""
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock,
  })
}

function buildSetupNote(cwd: string): null | string {
  const availability = getKimiAvailability(cwd)
  if (availability.available) {
    return null
  }

  const detail = availability.detail ? ` ${availability.detail}.` : ""
  return `Kimi is not set up for the review gate.${detail} Run /kimi:setup.`
}

function parseStopReviewOutput(rawOutput: unknown): {
  ok: boolean
  reason: null | string
} {
  const text = coerceString(rawOutput).trim()
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task returned no final output. Run /kimi:review --wait manually or bypass the gate.",
    }
  }

  const firstLine = text.split(/\r?\n/, 1)[0]!.trim()
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null }
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text
    return {
      ok: false,
      reason: `Kimi stop-time review found issues that still need fixes before ending the session: ${reason}`,
    }
  }

  return {
    ok: false,
    reason:
      "The stop-time Kimi review task returned an unexpected answer. Run /kimi:review --wait manually or bypass the gate.",
  }
}

function runStopReview(
  cwd: string,
  input: HookInput = {},
): { ok: boolean; reason: null | string } {
  const scriptPath = path.join(SCRIPT_DIR, "kimi-companion.js")
  const prompt = buildStopReviewPrompt(input)
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {}),
  }
  const result = spawnSync(
    process.execPath,
    [scriptPath, "task", "--json", prompt],
    {
      cwd,
      encoding: "utf8",
      env: childEnv,
      timeout: STOP_REVIEW_TIMEOUT_MS,
    },
  )

  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  ) {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task timed out after 15 minutes. Run /kimi:review --wait manually or bypass the gate.",
    }
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim()
    return {
      ok: false,
      reason: detail
        ? `The stop-time Kimi review task failed: ${detail}`
        : "The stop-time Kimi review task failed. Run /kimi:review --wait manually or bypass the gate.",
    }
  }

  try {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>
    return parseStopReviewOutput(payload.rawOutput ?? payload.payload)
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task returned invalid JSON. Run /kimi:review --wait manually or bypass the gate.",
    }
  }
}

function main(): void {
  const input = readHookInput()
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const config = getConfig(workspaceRoot)

  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(listJobs(workspaceRoot), input),
  )
  const runningJob = jobs.find(
    (job) => job.status === "queued" || job.status === "running",
  )
  const runningTaskNote = runningJob
    ? `Kimi task ${runningJob.id} is still running. Check /kimi:status and use /kimi:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null

  if (!config.stopReviewGate) {
    logNote(runningTaskNote)
    return
  }

  const setupNote = buildSetupNote(cwd)
  if (setupNote) {
    logNote(setupNote)
    logNote(runningTaskNote)
    return
  }

  const review = runStopReview(cwd, input)
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote
        ? `${runningTaskNote} ${review.reason}`
        : review.reason,
    })
    return
  }

  logNote(runningTaskNote)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
