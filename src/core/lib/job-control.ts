import fs from "node:fs"
import process from "node:process"

import type { ProviderContext } from "./provider.js"
import {
  getConfig,
  type JobRecord,
  listJobs,
  readJobFile,
  resolveJobFile,
  type StateConfig,
} from "./state.js"
import { coerceString } from "./strings.js"
import { resolveWorkspaceRoot } from "./workspace.js"

export const DEFAULT_MAX_STATUS_JOBS = 8
export const DEFAULT_MAX_PROGRESS_LINES = 4

interface SessionOptions {
  [key: string]: unknown
  env?: Record<string, string | undefined>
}

interface EnrichOptions {
  maxProgressLines?: number
}

export interface SessionRuntimeStatus {
  detail: string
  endpoint: null | string
  label: string
  mode: string
}

export type SessionRuntimeStatusFn = (
  env: Record<string, string | undefined> | undefined,
  workspaceRoot: string,
) => SessionRuntimeStatus

interface StatusOptions extends SessionOptions {
  all?: boolean
  getSessionRuntimeStatus: SessionRuntimeStatusFn
  maxJobs?: number
  maxProgressLines?: number
}

interface SingleJobOptions {
  maxProgressLines?: number
}

interface StatusSnapshot {
  config: StateConfig
  latestFinished: JobRecord | null
  needsReview: boolean
  recent: JobRecord[]
  running: JobRecord[]
  sessionRuntime: SessionRuntimeStatus
  workspaceRoot: string
}

interface SingleJobSnapshot {
  job: JobRecord
  workspaceRoot: string
}

export function sortJobsNewestFirst(jobs: JobRecord[]): JobRecord[] {
  return [...jobs].sort((left, right) =>
    coerceString(right.updatedAt).localeCompare(coerceString(left.updatedAt)),
  )
}

function getCurrentSessionId(
  config: ProviderContext,
  options: SessionOptions = {},
): null | string {
  return (
    (options.env?.[config.envVars.sessionId] as string | undefined) ??
    process.env[config.envVars.sessionId] ??
    null
  )
}

function filterJobsForCurrentSession(
  config: ProviderContext,
  jobs: JobRecord[],
  options: SessionOptions = {},
): JobRecord[] {
  const sessionId = getCurrentSessionId(config, options)
  if (!sessionId) {
    return jobs
  }
  return jobs.filter((job) => job.sessionId === sessionId)
}

function getJobTypeLabel(job: JobRecord): string {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review"
  }
  if (job.jobClass === "review") {
    return "review"
  }
  if (job.jobClass === "task") {
    return "rescue"
  }
  if (job.kind === "review") {
    return "review"
  }
  if (job.kind === "task") {
    return "rescue"
  }
  return "job"
}

function stripLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim()
}

function isProgressBlockTitle(line: string): boolean {
  return (
    [
      "Assistant message",
      "Final output",
      "Reasoning summary",
      "Review output",
    ].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  )
}

export function readJobProgressPreview(
  logFile: null | string | undefined,
  maxLines: number = DEFAULT_MAX_PROGRESS_LINES,
): string[] {
  if (!logFile || !fs.existsSync(logFile)) {
    return []
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line))

  return lines.slice(-maxLines)
}

function formatElapsedDuration(
  startValue: null | string | undefined,
  endValue: null | string | undefined = null,
): null | string {
  const start = Date.parse(startValue ?? "")
  if (!Number.isFinite(start)) {
    return null
  }

  const end = endValue ? Date.parse(endValue) : Date.now()
  if (!Number.isFinite(end) || end < start) {
    return null
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function looksLikeVerificationCommand(line: string): boolean {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line,
  )
}

function inferLegacyJobPhase(
  config: ProviderContext,
  job: JobRecord,
  progressPreview: string[] = [],
): string {
  switch (job.status) {
    case "queued":
      return "queued"
    case "cancelled":
      return "cancelled"
    case "failed":
      return "failed"
    case "completed":
      return "done"
    default:
      break
  }

  const startingPrefix = `starting ${config.id}`
  const errorPrefix = `${config.id} error:`

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index]!.toLowerCase()
    if (
      line.startsWith(startingPrefix) ||
      line.startsWith("thread ready") ||
      line.startsWith("turn started")
    ) {
      return "starting"
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing"
    }
    if (
      line.startsWith("searching:") ||
      line.startsWith("calling ") ||
      line.startsWith("running tool:")
    ) {
      return "investigating"
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating"
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating"
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running"
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing"
    }
    if (line.startsWith("turn completed")) {
      return "finalizing"
    }
    if (line.startsWith(errorPrefix) || line.startsWith("failed:")) {
      return "failed"
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running"
}

export function enrichJob(
  config: ProviderContext,
  job: JobRecord,
  options: EnrichOptions = {},
): JobRecord {
  const maxProgressLines =
    options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES
  const enriched: JobRecord = {
    ...job,
    duration:
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
        ? formatElapsedDuration(
            (job.startedAt as string | undefined) ??
              (job.createdAt as string | undefined),
            (job.completedAt as string | undefined) ??
              (job.updatedAt as string | undefined),
          )
        : null,
    elapsed: formatElapsedDuration(
      (job.startedAt as string | undefined) ??
        (job.createdAt as string | undefined),
      (job.completedAt as string | undefined) ?? null,
    ),
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "failed"
        ? readJobProgressPreview(
            job.logFile as string | undefined,
            maxProgressLines,
          )
        : [],
  }

  return {
    ...enriched,
    phase:
      enriched.phase ??
      inferLegacyJobPhase(
        config,
        enriched,
        enriched.progressPreview as string[],
      ),
  }
}

export function readStoredJob(
  config: ProviderContext,
  workspaceRoot: string,
  jobId: string,
): null | Record<string, unknown> {
  const jobFile = resolveJobFile(config, workspaceRoot, jobId)
  if (!fs.existsSync(jobFile)) {
    return null
  }
  return readJobFile(jobFile)
}

function matchJobReference(
  config: ProviderContext,
  jobs: JobRecord[],
  reference: null | string | undefined,
  predicate: (job: JobRecord) => boolean = () => true,
): JobRecord | null {
  const filtered = jobs.filter(predicate)
  if (!reference) {
    return filtered[0] ?? null
  }

  const exact = filtered.find((job) => job.id === reference)
  if (exact) {
    return exact
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference))
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Job reference "${reference}" is ambiguous. Use a longer job id.`,
    )
  }

  throw new Error(
    `No job found for "${reference}". Run ${config.slashPrefix}:status to list known jobs.`,
  )
}

export function buildStatusSnapshot(
  config: ProviderContext,
  cwd: string,
  options: StatusOptions,
): StatusSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const stateConfig = getConfig(config, workspaceRoot)
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(
      config,
      listJobs(config, workspaceRoot),
      options,
    ),
  )
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS
  const maxProgressLines =
    options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(config, job, { maxProgressLines }))

  const latestFinishedRaw =
    jobs.find((job) => job.status !== "queued" && job.status !== "running") ??
    null
  const latestFinished = latestFinishedRaw
    ? enrichJob(config, latestFinishedRaw, { maxProgressLines })
    : null

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter(
      (job) =>
        job.status !== "queued" &&
        job.status !== "running" &&
        job.id !== latestFinished?.id,
    )
    .map((job) => enrichJob(config, job, { maxProgressLines }))

  return {
    config: stateConfig,
    latestFinished,
    needsReview: Boolean(stateConfig.stopReviewGate),
    recent,
    running,
    sessionRuntime: options.getSessionRuntimeStatus(options.env, workspaceRoot),
    workspaceRoot,
  }
}

export function buildSingleJobSnapshot(
  config: ProviderContext,
  cwd: string,
  reference: null | string | undefined,
  options: SingleJobOptions = {},
): SingleJobSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const jobs = sortJobsNewestFirst(listJobs(config, workspaceRoot))
  const selected = matchJobReference(config, jobs, reference)
  if (!selected) {
    throw new Error(
      `No job found for "${reference}". Run ${config.slashPrefix}:status to inspect known jobs.`,
    )
  }

  return {
    job: enrichJob(config, selected, {
      maxProgressLines: options.maxProgressLines,
    }),
    workspaceRoot,
  }
}

export function resolveResultJob(
  config: ProviderContext,
  cwd: string,
  reference: null | string | undefined,
): SingleJobSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const jobs = sortJobsNewestFirst(
    reference
      ? listJobs(config, workspaceRoot)
      : filterJobsForCurrentSession(config, listJobs(config, workspaceRoot)),
  )
  const selected = matchJobReference(
    config,
    jobs,
    reference,
    (job) =>
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled",
  )

  if (selected) {
    return { job: selected, workspaceRoot }
  }

  const active = matchJobReference(
    config,
    jobs,
    reference,
    (job) => job.status === "queued" || job.status === "running",
  )
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${coerceString(active.status, "unknown")}. Check ${config.slashPrefix}:status and try again once it finishes.`,
    )
  }

  if (reference) {
    throw new Error(
      `No finished job found for "${reference}". Run ${config.slashPrefix}:status to inspect active jobs.`,
    )
  }

  throw new Error(
    `No finished ${config.displayName} jobs found for this repository yet.`,
  )
}

export function resolveCancelableJob(
  config: ProviderContext,
  cwd: string,
  reference: null | string | undefined,
  options: SessionOptions = {},
): SingleJobSnapshot {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const jobs = sortJobsNewestFirst(listJobs(config, workspaceRoot))
  const activeJobs = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  )

  if (reference) {
    const selected = matchJobReference(config, activeJobs, reference)
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`)
    }
    return { job: selected, workspaceRoot }
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(
    config,
    activeJobs,
    options,
  )

  if (sessionScopedActiveJobs.length === 1) {
    return { job: sessionScopedActiveJobs[0]!, workspaceRoot }
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error(
      `Multiple ${config.displayName} jobs are active. Pass a job id to ${config.slashPrefix}:cancel.`,
    )
  }

  if (getCurrentSessionId(config, options)) {
    throw new Error(
      `No active ${config.displayName} jobs to cancel for this session.`,
    )
  }

  throw new Error(`No active ${config.displayName} jobs to cancel.`)
}
