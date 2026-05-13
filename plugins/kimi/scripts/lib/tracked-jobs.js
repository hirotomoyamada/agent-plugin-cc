import * as core from "../../core/lib/tracked-jobs.js";
import { KIMI_PROVIDER } from "./provider-config.js";
export const SESSION_ID_ENV = KIMI_PROVIDER.envVars.sessionId;
export const createJobLogFile = (workspaceRoot, jobId, title) => core.createJobLogFile(KIMI_PROVIDER, workspaceRoot, jobId, title);
export const createJobRecord = (base, options = {}) => core.createJobRecord(KIMI_PROVIDER, base, { env: options.env });
export const createJobProgressUpdater = (workspaceRoot, jobId) => core.createJobProgressUpdater(KIMI_PROVIDER, workspaceRoot, jobId);
export const createProgressReporter = (options = {}) => core.createProgressReporter(KIMI_PROVIDER, options);
export const runTrackedJob = (job, runner, options = {}) => core.runTrackedJob(KIMI_PROVIDER, job, runner, options);
export { appendLogBlock, appendLogLine, nowIso, } from "../../core/lib/tracked-jobs.js";
