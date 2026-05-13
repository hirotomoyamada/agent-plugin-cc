import { fileURLToPath } from "node:url";
import * as core from "../../core/lib/broker-lifecycle.js";
import { KIMI_PROVIDER } from "./provider-config.js";
const DEFAULT_BROKER_SCRIPT = fileURLToPath(new URL("../app-server-broker.js", import.meta.url));
export const PID_FILE_ENV = KIMI_PROVIDER.envVars.pidFile;
export const LOG_FILE_ENV = KIMI_PROVIDER.envVars.logFile;
export const createBrokerSessionDir = (prefix) => core.createBrokerSessionDir(KIMI_PROVIDER, prefix);
export const loadBrokerSession = (cwd) => core.loadBrokerSession(KIMI_PROVIDER, cwd);
export const saveBrokerSession = (cwd, session) => core.saveBrokerSession(KIMI_PROVIDER, cwd, session);
export const clearBrokerSession = (cwd) => core.clearBrokerSession(KIMI_PROVIDER, cwd);
export const ensureBrokerSession = (cwd, options = {}) => core.ensureBrokerSession(KIMI_PROVIDER, cwd, {
    ...options,
    scriptPath: options.scriptPath ?? DEFAULT_BROKER_SCRIPT,
});
export { sendBrokerShutdown, spawnBrokerProcess, teardownBrokerSession, waitForBrokerEndpoint, } from "../../core/lib/broker-lifecycle.js";
