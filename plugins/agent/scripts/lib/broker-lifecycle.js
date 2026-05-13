import { fileURLToPath } from "node:url";
import * as core from "../../core/lib/broker-lifecycle.js";
import { AGENT_PROVIDER } from "./provider-config.js";
const DEFAULT_BROKER_SCRIPT = fileURLToPath(new URL("../app-server-broker.js", import.meta.url));
export const PID_FILE_ENV = AGENT_PROVIDER.envVars.pidFile;
export const LOG_FILE_ENV = AGENT_PROVIDER.envVars.logFile;
export const createBrokerSessionDir = (prefix) => core.createBrokerSessionDir(AGENT_PROVIDER, prefix);
export const loadBrokerSession = (cwd) => core.loadBrokerSession(AGENT_PROVIDER, cwd);
export const saveBrokerSession = (cwd, session) => core.saveBrokerSession(AGENT_PROVIDER, cwd, session);
export const clearBrokerSession = (cwd) => core.clearBrokerSession(AGENT_PROVIDER, cwd);
export const ensureBrokerSession = (cwd, options = {}) => core.ensureBrokerSession(AGENT_PROVIDER, cwd, {
    ...options,
    scriptPath: options.scriptPath ?? DEFAULT_BROKER_SCRIPT,
});
export { sendBrokerShutdown, spawnBrokerProcess, teardownBrokerSession, waitForBrokerEndpoint, } from "../../core/lib/broker-lifecycle.js";
