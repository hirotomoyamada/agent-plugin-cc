import * as core from "../../core/lib/job-control.js";
import { getSessionRuntimeStatus } from "./kimi.js";
import { KIMI_PROVIDER } from "./provider-config.js";
export const buildStatusSnapshot = (cwd, options = {}) => core.buildStatusSnapshot(KIMI_PROVIDER, cwd, {
    ...options,
    getSessionRuntimeStatus,
});
export const buildSingleJobSnapshot = (cwd, reference, options = {}) => core.buildSingleJobSnapshot(KIMI_PROVIDER, cwd, reference, options);
export const readStoredJob = (workspaceRoot, jobId) => core.readStoredJob(KIMI_PROVIDER, workspaceRoot, jobId);
export const resolveResultJob = (cwd, reference) => core.resolveResultJob(KIMI_PROVIDER, cwd, reference);
export const resolveCancelableJob = (cwd, reference, options = {}) => core.resolveCancelableJob(KIMI_PROVIDER, cwd, reference, options);
export { DEFAULT_MAX_PROGRESS_LINES, DEFAULT_MAX_STATUS_JOBS, enrichJob, readJobProgressPreview, sortJobsNewestFirst, } from "../../core/lib/job-control.js";
