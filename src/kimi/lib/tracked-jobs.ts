import * as core from "../../core/lib/tracked-jobs.js"

import { KIMI_PROVIDER } from "./provider-config.js"

export const SESSION_ID_ENV = KIMI_PROVIDER.envVars.sessionId

export const createJobLogFile = (
  workspaceRoot: string,
  jobId: string,
  title?: string,
) => core.createJobLogFile(KIMI_PROVIDER, workspaceRoot, jobId, title)

interface CreateJobRecordOptionsShim {
  env?: Record<string, string | undefined>
  sessionIdEnv?: string
}

export const createJobRecord = (
  base: Record<string, unknown>,
  options: CreateJobRecordOptionsShim = {},
) => core.createJobRecord(KIMI_PROVIDER, base, { env: options.env })

export const createJobProgressUpdater = (
  workspaceRoot: string,
  jobId: string,
) => core.createJobProgressUpdater(KIMI_PROVIDER, workspaceRoot, jobId)

interface ProgressReporterOptions {
  logFile?: null | string
  onEvent?: ((event: unknown) => void) | null
  stderr?: boolean
}

export const createProgressReporter = (options: ProgressReporterOptions = {}) =>
  core.createProgressReporter(KIMI_PROVIDER, options as never)

interface RunTrackedJobOptions {
  logFile?: null | string
}

export const runTrackedJob = (
  job: core.TrackedJob,
  runner: () => Promise<core.JobExecution>,
  options: RunTrackedJobOptions = {},
) => core.runTrackedJob(KIMI_PROVIDER, job, runner, options)

export {
  appendLogBlock,
  appendLogLine,
  nowIso,
} from "../../core/lib/tracked-jobs.js"
export type {
  JobExecution,
  ProgressReporter,
  TrackedJob,
} from "../../core/lib/tracked-jobs.js"
