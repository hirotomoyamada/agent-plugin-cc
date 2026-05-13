import * as core from "../../core/lib/job-control.js";
import { getSessionRuntimeStatus } from "./agent.js";
import { AGENT_PROVIDER } from "./provider-config.js";
export const buildStatusSnapshot = (cwd, options = {}) => core.buildStatusSnapshot(AGENT_PROVIDER, cwd, {
    ...options,
    getSessionRuntimeStatus,
});
export const buildSingleJobSnapshot = (cwd, reference, options = {}) => core.buildSingleJobSnapshot(AGENT_PROVIDER, cwd, reference, options);
export const readStoredJob = (workspaceRoot, jobId) => core.readStoredJob(AGENT_PROVIDER, workspaceRoot, jobId);
export const resolveResultJob = (cwd, reference) => core.resolveResultJob(AGENT_PROVIDER, cwd, reference);
export const resolveCancelableJob = (cwd, reference, options = {}) => core.resolveCancelableJob(AGENT_PROVIDER, cwd, reference, options);
export { DEFAULT_MAX_PROGRESS_LINES, DEFAULT_MAX_STATUS_JOBS, enrichJob, readJobProgressPreview, sortJobsNewestFirst, } from "../../core/lib/job-control.js";
