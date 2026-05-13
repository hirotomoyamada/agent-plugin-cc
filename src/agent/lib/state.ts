import * as core from "../../core/lib/state.js"

import { AGENT_PROVIDER } from "./provider-config.js"

export const resolveStateDir = (cwd: string) =>
  core.resolveStateDir(AGENT_PROVIDER, cwd)

export const resolveStateFile = (cwd: string) =>
  core.resolveStateFile(AGENT_PROVIDER, cwd)

export const resolveJobsDir = (cwd: string) =>
  core.resolveJobsDir(AGENT_PROVIDER, cwd)

export const ensureStateDir = (cwd: string) =>
  core.ensureStateDir(AGENT_PROVIDER, cwd)

export const loadState = (cwd: string) => core.loadState(AGENT_PROVIDER, cwd)

export const saveState = (cwd: string, state: core.AppState) =>
  core.saveState(AGENT_PROVIDER, cwd, state)

export const updateState = (
  cwd: string,
  mutate: (state: core.AppState) => void,
) => core.updateState(AGENT_PROVIDER, cwd, mutate)

export const upsertJob = (cwd: string, jobPatch: core.JobRecord) =>
  core.upsertJob(AGENT_PROVIDER, cwd, jobPatch)

export const listJobs = (cwd: string) => core.listJobs(AGENT_PROVIDER, cwd)

export const setConfig = (cwd: string, key: string, value: unknown) =>
  core.setConfig(AGENT_PROVIDER, cwd, key, value)

export const getConfig = (cwd: string) => core.getConfig(AGENT_PROVIDER, cwd)

export const writeJobFile = (
  cwd: string,
  jobId: string,
  payload: Record<string, unknown>,
) => core.writeJobFile(AGENT_PROVIDER, cwd, jobId, payload)

export const resolveJobLogFile = (cwd: string, jobId: string) =>
  core.resolveJobLogFile(AGENT_PROVIDER, cwd, jobId)

export const resolveJobFile = (cwd: string, jobId: string) =>
  core.resolveJobFile(AGENT_PROVIDER, cwd, jobId)

export { generateJobId, readJobFile } from "../../core/lib/state.js"
export type { AppState, JobRecord, StateConfig } from "../../core/lib/state.js"
