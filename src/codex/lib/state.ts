import * as core from "../../core/lib/state.js"

import { CODEX_PROVIDER } from "./provider-config.js"

export const resolveStateDir = (cwd: string) =>
  core.resolveStateDir(CODEX_PROVIDER, cwd)

export const resolveStateFile = (cwd: string) =>
  core.resolveStateFile(CODEX_PROVIDER, cwd)

export const resolveJobsDir = (cwd: string) =>
  core.resolveJobsDir(CODEX_PROVIDER, cwd)

export const ensureStateDir = (cwd: string) =>
  core.ensureStateDir(CODEX_PROVIDER, cwd)

export const loadState = (cwd: string) => core.loadState(CODEX_PROVIDER, cwd)

export const saveState = (cwd: string, state: core.AppState) =>
  core.saveState(CODEX_PROVIDER, cwd, state)

export const updateState = (
  cwd: string,
  mutate: (state: core.AppState) => void,
) => core.updateState(CODEX_PROVIDER, cwd, mutate)

export const upsertJob = (cwd: string, jobPatch: core.JobRecord) =>
  core.upsertJob(CODEX_PROVIDER, cwd, jobPatch)

export const listJobs = (cwd: string) => core.listJobs(CODEX_PROVIDER, cwd)

export const setConfig = (cwd: string, key: string, value: unknown) =>
  core.setConfig(CODEX_PROVIDER, cwd, key, value)

export const getConfig = (cwd: string) => core.getConfig(CODEX_PROVIDER, cwd)

export const writeJobFile = (
  cwd: string,
  jobId: string,
  payload: Record<string, unknown>,
) => core.writeJobFile(CODEX_PROVIDER, cwd, jobId, payload)

export const resolveJobLogFile = (cwd: string, jobId: string) =>
  core.resolveJobLogFile(CODEX_PROVIDER, cwd, jobId)

export const resolveJobFile = (cwd: string, jobId: string) =>
  core.resolveJobFile(CODEX_PROVIDER, cwd, jobId)

export { generateJobId, readJobFile } from "../../core/lib/state.js"
export type { AppState, JobRecord, StateConfig } from "../../core/lib/state.js"
