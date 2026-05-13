import fs from "node:fs"
import process from "node:process"

import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile,
} from "./state.js"
import { coerceString } from "./strings.js"

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"

interface NormalizedProgressEvent {
  logBody: null | string
  logTitle: null | string
  message: string
  phase: null | string
  stderrMessage: null | string
  threadId: null | string
  turnId: null | string
}

export interface JobExecution {
  exitStatus: number
  payload: unknown
  rendered: string
  summary: string
  threadId?: null | string
  turnId?: null | string
}

export interface TrackedJob {
  [key: string]: unknown
  id: string
  logFile?: null | string
  workspaceRoot: string
}

export type ProgressReporter = ((eventOrMessage: unknown) => void) | null

export function nowIso(): string {
  return new Date().toISOString()
}

function normalizeProgressEvent(value: unknown): NormalizedProgressEvent {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    return {
      logBody: obj.logBody == null ? null : coerceString(obj.logBody).trimEnd(),
      logTitle:
        typeof obj.logTitle === "string" && obj.logTitle.trim()
          ? obj.logTitle.trim()
          : null,
      message: coerceString(obj.message).trim(),
      phase:
        typeof obj.phase === "string" && obj.phase.trim()
          ? obj.phase.trim()
          : null,
      stderrMessage:
        obj.stderrMessage == null
          ? null
          : coerceString(obj.stderrMessage).trim(),
      threadId:
        typeof obj.threadId === "string" && obj.threadId.trim()
          ? obj.threadId.trim()
          : null,
      turnId:
        typeof obj.turnId === "string" && obj.turnId.trim()
          ? obj.turnId.trim()
          : null,
    }
  }

  const text = coerceString(value).trim()
  return {
    logBody: null,
    logTitle: null,
    message: text,
    phase: null,
    stderrMessage: text,
    threadId: null,
    turnId: null,
  }
}

export function appendLogLine(logFile: null | string, message: unknown): void {
  const normalized = coerceString(message).trim()
  if (!logFile || !normalized) {
    return
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8")
}

export function appendLogBlock(
  logFile: null | string,
  title: null | string,
  body: unknown,
): void {
  if (!logFile || !body) {
    return
  }
  fs.appendFileSync(
    logFile,
    `\n[${nowIso()}] ${title}\n${coerceString(body).trimEnd()}\n`,
    "utf8",
  )
}

export function createJobLogFile(
  workspaceRoot: string,
  jobId: string,
  title?: string,
): string {
  const logFile = resolveJobLogFile(workspaceRoot, jobId)
  fs.writeFileSync(logFile, "", "utf8")
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`)
  }
  return logFile
}

interface CreateJobRecordOptions {
  env?: Record<string, string | undefined>
  sessionIdEnv?: string
}

export function createJobRecord(
  base: Record<string, unknown>,
  options: CreateJobRecordOptions = {},
): Record<string, unknown> {
  const env = options.env ?? process.env
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV]
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  }
}

export function createJobProgressUpdater(
  workspaceRoot: string,
  jobId: string,
): (event: unknown) => void {
  let lastPhase: null | string = null
  let lastThreadId: null | string = null
  let lastTurnId: null | string = null

  return (event: unknown): void => {
    const normalized = normalizeProgressEvent(event)
    const patch: Record<string, unknown> = { id: jobId }
    let changed = false

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase
      patch.phase = normalized.phase
      changed = true
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId
      patch.threadId = normalized.threadId
      changed = true
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId
      patch.turnId = normalized.turnId
      changed = true
    }

    if (!changed) {
      return
    }

    upsertJob(workspaceRoot, { id: jobId, ...patch })

    const jobFile = resolveJobFile(workspaceRoot, jobId)
    if (!fs.existsSync(jobFile)) {
      return
    }

    const storedJob = readJobFile(jobFile)
    writeJobFile(workspaceRoot, jobId, { ...storedJob, ...patch })
  }
}

interface ProgressReporterOptions {
  logFile?: null | string
  onEvent?: ((event: NormalizedProgressEvent) => void) | null
  stderr?: boolean
}

export function createProgressReporter(
  options: ProgressReporterOptions = {},
): ProgressReporter {
  const { logFile = null, onEvent = null, stderr = false } = options
  if (!stderr && !logFile && !onEvent) {
    return null
  }

  return (eventOrMessage: unknown): void => {
    const event = normalizeProgressEvent(eventOrMessage)
    const stderrMessage = event.stderrMessage ?? event.message
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`)
    }
    appendLogLine(logFile, event.message)
    appendLogBlock(logFile, event.logTitle, event.logBody)
    onEvent?.(event)
  }
}

function readStoredJobOrNull(
  workspaceRoot: string,
  jobId: string,
): null | Record<string, unknown> {
  const jobFile = resolveJobFile(workspaceRoot, jobId)
  if (!fs.existsSync(jobFile)) {
    return null
  }
  return readJobFile(jobFile)
}

interface RunTrackedJobOptions {
  logFile?: null | string
}

export async function runTrackedJob(
  job: TrackedJob,
  runner: () => Promise<JobExecution>,
  options: RunTrackedJobOptions = {},
): Promise<JobExecution> {
  const runningRecord: Record<string, unknown> = {
    ...job,
    logFile: options.logFile ?? job.logFile ?? null,
    phase: "starting",
    pid: process.pid,
    startedAt: nowIso(),
    status: "running",
  }
  writeJobFile(job.workspaceRoot, job.id, runningRecord)
  upsertJob(job.workspaceRoot, { id: job.id, ...runningRecord })

  try {
    const execution = await runner()
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed"
    const completedAt = nowIso()
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      completedAt,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      rendered: execution.rendered,
      result: execution.payload,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
    })
    upsertJob(job.workspaceRoot, {
      completedAt,
      id: job.id,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      status: completionStatus,
      summary: execution.summary,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
    })
    appendLogBlock(
      options.logFile ?? job.logFile ?? null,
      "Final output",
      execution.rendered,
    )
    return execution
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const existing =
      readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord
    const completedAt = nowIso()
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      completedAt,
      errorMessage,
      logFile:
        options.logFile ??
        job.logFile ??
        (existing.logFile as null | string) ??
        null,
      phase: "failed",
      pid: null,
      status: "failed",
    })
    upsertJob(job.workspaceRoot, {
      completedAt,
      errorMessage,
      id: job.id,
      phase: "failed",
      pid: null,
      status: "failed",
    })
    throw error
  }
}
