import * as core from "../../core/lib/state.js"

import { KIMI_PROVIDER } from "./provider-config.js"

export const resolveStateDir = (cwd: string) =>
  core.resolveStateDir(KIMI_PROVIDER, cwd)

export const resolveStateFile = (cwd: string) =>
  core.resolveStateFile(KIMI_PROVIDER, cwd)

export const resolveJobsDir = (cwd: string) =>
  core.resolveJobsDir(KIMI_PROVIDER, cwd)

export const ensureStateDir = (cwd: string) =>
  core.ensureStateDir(KIMI_PROVIDER, cwd)

export const loadState = (cwd: string) => core.loadState(KIMI_PROVIDER, cwd)

export const saveState = (cwd: string, state: core.AppState) =>
  core.saveState(KIMI_PROVIDER, cwd, state)

export const updateState = (
  cwd: string,
  mutate: (state: core.AppState) => void,
) => core.updateState(KIMI_PROVIDER, cwd, mutate)

export const upsertJob = (cwd: string, jobPatch: core.JobRecord) =>
  core.upsertJob(KIMI_PROVIDER, cwd, jobPatch)

export const listJobs = (cwd: string) => core.listJobs(KIMI_PROVIDER, cwd)

export const setConfig = (cwd: string, key: string, value: unknown) =>
  core.setConfig(KIMI_PROVIDER, cwd, key, value)

export const getConfig = (cwd: string) => core.getConfig(KIMI_PROVIDER, cwd)

export const writeJobFile = (
  cwd: string,
  jobId: string,
  payload: Record<string, unknown>,
) => core.writeJobFile(KIMI_PROVIDER, cwd, jobId, payload)

export const resolveJobLogFile = (cwd: string, jobId: string) =>
  core.resolveJobLogFile(KIMI_PROVIDER, cwd, jobId)

export const resolveJobFile = (cwd: string, jobId: string) =>
  core.resolveJobFile(KIMI_PROVIDER, cwd, jobId)

export { generateJobId, readJobFile } from "../../core/lib/state.js"
export type { AppState, JobRecord, StateConfig } from "../../core/lib/state.js"
