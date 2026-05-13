import * as core from "../../core/lib/job-control.js"

import { getSessionRuntimeStatus } from "./kimi.js"
import { KIMI_PROVIDER } from "./provider-config.js"

interface StatusOptionsShim {
  [key: string]: unknown
  all?: boolean
  env?: Record<string, string | undefined>
  maxJobs?: number
  maxProgressLines?: number
}

interface SingleJobOptionsShim {
  maxProgressLines?: number
}

interface SessionOptionsShim {
  [key: string]: unknown
  env?: Record<string, string | undefined>
}

export const buildStatusSnapshot = (
  cwd: string,
  options: StatusOptionsShim = {},
) =>
  core.buildStatusSnapshot(KIMI_PROVIDER, cwd, {
    ...options,
    getSessionRuntimeStatus,
  })

export const buildSingleJobSnapshot = (
  cwd: string,
  reference: null | string | undefined,
  options: SingleJobOptionsShim = {},
) => core.buildSingleJobSnapshot(KIMI_PROVIDER, cwd, reference, options)

export const readStoredJob = (workspaceRoot: string, jobId: string) =>
  core.readStoredJob(KIMI_PROVIDER, workspaceRoot, jobId)

export const resolveResultJob = (
  cwd: string,
  reference: null | string | undefined,
) => core.resolveResultJob(KIMI_PROVIDER, cwd, reference)

export const resolveCancelableJob = (
  cwd: string,
  reference: null | string | undefined,
  options: SessionOptionsShim = {},
) => core.resolveCancelableJob(KIMI_PROVIDER, cwd, reference, options)

export {
  DEFAULT_MAX_PROGRESS_LINES,
  DEFAULT_MAX_STATUS_JOBS,
  enrichJob,
  readJobProgressPreview,
  sortJobsNewestFirst,
} from "../../core/lib/job-control.js"
export type {
  SessionRuntimeStatus,
  SessionRuntimeStatusFn,
} from "../../core/lib/job-control.js"
