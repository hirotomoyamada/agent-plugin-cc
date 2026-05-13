import * as core from "../../core/lib/tracked-jobs.js";
import { AGENT_PROVIDER } from "./provider-config.js";
export const SESSION_ID_ENV = AGENT_PROVIDER.envVars.sessionId;
export const createJobLogFile = (workspaceRoot, jobId, title) => core.createJobLogFile(AGENT_PROVIDER, workspaceRoot, jobId, title);
export const createJobRecord = (base, options = {}) => core.createJobRecord(AGENT_PROVIDER, base, { env: options.env });
export const createJobProgressUpdater = (workspaceRoot, jobId) => core.createJobProgressUpdater(AGENT_PROVIDER, workspaceRoot, jobId);
export const createProgressReporter = (options = {}) => core.createProgressReporter(AGENT_PROVIDER, options);
export const runTrackedJob = (job, runner, options = {}) => core.runTrackedJob(AGENT_PROVIDER, job, runner, options);
export { appendLogBlock, appendLogLine, nowIso, } from "../../core/lib/tracked-jobs.js";
