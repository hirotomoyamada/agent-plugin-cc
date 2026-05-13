import * as core from "../../core/lib/tracked-jobs.js";
import { CODEX_PROVIDER } from "./provider-config.js";
export const SESSION_ID_ENV = CODEX_PROVIDER.envVars.sessionId;
export const createJobLogFile = (workspaceRoot, jobId, title) => core.createJobLogFile(CODEX_PROVIDER, workspaceRoot, jobId, title);
export const createJobRecord = (base, options = {}) => core.createJobRecord(CODEX_PROVIDER, base, { env: options.env });
export const createJobProgressUpdater = (workspaceRoot, jobId) => core.createJobProgressUpdater(CODEX_PROVIDER, workspaceRoot, jobId);
export const createProgressReporter = (options = {}) => core.createProgressReporter(CODEX_PROVIDER, options);
export const runTrackedJob = (job, runner, options = {}) => core.runTrackedJob(CODEX_PROVIDER, job, runner, options);
export { appendLogBlock, appendLogLine, nowIso, } from "../../core/lib/tracked-jobs.js";
