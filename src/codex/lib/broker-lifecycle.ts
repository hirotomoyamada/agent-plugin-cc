import { fileURLToPath } from "node:url"

import * as core from "../../core/lib/broker-lifecycle.js"

import { CODEX_PROVIDER } from "./provider-config.js"

const DEFAULT_BROKER_SCRIPT = fileURLToPath(
  new URL("../app-server-broker.js", import.meta.url),
)

export const PID_FILE_ENV = CODEX_PROVIDER.envVars.pidFile
export const LOG_FILE_ENV = CODEX_PROVIDER.envVars.logFile

export const createBrokerSessionDir = (prefix?: string) =>
  core.createBrokerSessionDir(CODEX_PROVIDER, prefix)

export const loadBrokerSession = (cwd: string) =>
  core.loadBrokerSession(CODEX_PROVIDER, cwd)

export const saveBrokerSession = (cwd: string, session: core.BrokerSession) =>
  core.saveBrokerSession(CODEX_PROVIDER, cwd, session)

export const clearBrokerSession = (cwd: string) =>
  core.clearBrokerSession(CODEX_PROVIDER, cwd)

interface EnsureBrokerOptionsShim {
  env?: NodeJS.ProcessEnv
  killProcess?: ((pid: number) => void) | null
  platform?: NodeJS.Platform
  scriptPath?: string
  timeoutMs?: number
}

export const ensureBrokerSession = (
  cwd: string,
  options: EnsureBrokerOptionsShim = {},
) =>
  core.ensureBrokerSession(CODEX_PROVIDER, cwd, {
    ...options,
    scriptPath: options.scriptPath ?? DEFAULT_BROKER_SCRIPT,
  })

export {
  sendBrokerShutdown,
  spawnBrokerProcess,
  teardownBrokerSession,
  waitForBrokerEndpoint,
} from "../../core/lib/broker-lifecycle.js"
export type { BrokerSession } from "../../core/lib/broker-lifecycle.js"
