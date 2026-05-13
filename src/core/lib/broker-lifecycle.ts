import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import type { ProviderContext } from "./provider.js"
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.js"
import { resolveStateDir } from "./state.js"

const BROKER_STATE_FILE = "broker.json"

export interface BrokerSession {
  endpoint: string
  logFile: string
  pid: null | number
  pidFile: string
  sessionDir: string
}

interface SpawnBrokerOptions {
  cwd: string
  endpoint: string
  env?: NodeJS.ProcessEnv
  logFile: string
  pidFile: string
  scriptPath: string
}

interface EnsureBrokerOptions {
  createBrokerEndpoint?: (
    config: ProviderContext,
    sessionDir: string,
    platform?: NodeJS.Platform,
  ) => string
  env?: NodeJS.ProcessEnv
  killProcess?: ((pid: number) => void) | null
  platform?: NodeJS.Platform
  scriptPath: string
  timeoutMs?: number
}

interface TeardownOptions {
  endpoint?: null | string
  killProcess?: ((pid: number) => void) | null
  logFile: null | string
  pid?: null | number
  pidFile: null | string
  sessionDir?: null | string
}

export function createBrokerSessionDir(
  config: ProviderContext,
  prefix?: string,
): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), prefix ?? config.paths.brokerSessionPrefix),
  )
}

function connectToEndpoint(endpoint: string): net.Socket {
  const target = parseBrokerEndpoint(endpoint)
  return net.createConnection({ path: target.path })
}

export async function waitForBrokerEndpoint(
  endpoint: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connectToEndpoint(endpoint)
      socket.on("connect", () => {
        socket.end()
        resolve(true)
      })
      socket.on("error", () => resolve(false))
    })
    if (ready) {
      return true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  return false
}

export async function sendBrokerShutdown(endpoint: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = connectToEndpoint(endpoint)
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`,
      )
    })
    socket.on("data", () => {
      socket.end()
      resolve(undefined)
    })
    socket.on("error", () => resolve(undefined))
    socket.on("close", () => resolve(undefined))
  })
}

export function spawnBrokerProcess({
  cwd,
  endpoint,
  env = process.env,
  logFile,
  pidFile,
  scriptPath,
}: SpawnBrokerOptions): ChildProcess {
  const logFd = fs.openSync(logFile, "a")
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "serve",
      "--endpoint",
      endpoint,
      "--cwd",
      cwd,
      "--pid-file",
      pidFile,
    ],
    { cwd, detached: true, env, stdio: ["ignore", logFd, logFd] },
  )
  child.unref()
  fs.closeSync(logFd)
  return child
}

function resolveBrokerStateFile(config: ProviderContext, cwd: string): string {
  return path.join(resolveStateDir(config, cwd), BROKER_STATE_FILE)
}

export function loadBrokerSession(
  config: ProviderContext,
  cwd: string,
): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(config, cwd)
  if (!fs.existsSync(stateFile)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as BrokerSession
  } catch {
    return null
  }
}

export function saveBrokerSession(
  config: ProviderContext,
  cwd: string,
  session: BrokerSession,
): void {
  const stateDir = resolveStateDir(config, cwd)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    resolveBrokerStateFile(config, cwd),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  )
}

export function clearBrokerSession(config: ProviderContext, cwd: string): void {
  const stateFile = resolveBrokerStateFile(config, cwd)
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile)
  }
}

async function isBrokerEndpointReady(
  endpoint: null | string | undefined,
): Promise<boolean> {
  if (!endpoint) {
    return false
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150)
  } catch {
    return false
  }
}

export async function ensureBrokerSession(
  config: ProviderContext,
  cwd: string,
  options: EnsureBrokerOptions,
): Promise<BrokerSession | null> {
  const existing = loadBrokerSession(config, cwd)
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing
  }
  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      killProcess: options.killProcess ?? null,
      logFile: existing.logFile ?? null,
      pid: existing.pid ?? null,
      pidFile: existing.pidFile ?? null,
      sessionDir: existing.sessionDir ?? null,
    })
    clearBrokerSession(config, cwd)
  }
  const sessionDir = createBrokerSessionDir(config)
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint
  const endpoint = endpointFactory(config, sessionDir, options.platform)
  const pidFile = path.join(sessionDir, "broker.pid")
  const logFile = path.join(sessionDir, "broker.log")
  const child = spawnBrokerProcess({
    cwd,
    endpoint,
    env: options.env ?? process.env,
    logFile,
    pidFile,
    scriptPath: options.scriptPath,
  })
  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000)
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      killProcess: options.killProcess ?? null,
      logFile,
      pid: child.pid ?? null,
      pidFile,
      sessionDir,
    })
    return null
  }
  const session: BrokerSession = {
    endpoint,
    logFile,
    pid: child.pid ?? null,
    pidFile,
    sessionDir,
  }
  saveBrokerSession(config, cwd, session)
  return session
}

export function teardownBrokerSession({
  endpoint = null,
  killProcess = null,
  logFile,
  pid = null,
  pidFile,
  sessionDir = null,
}: TeardownOptions): void {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid!)
    } catch {
      /* Ignore missing or already-exited broker processes. */
    }
  }
  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile)
  }
  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile)
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint)
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path)
      }
    } catch {
      /* Ignore malformed or already-removed broker endpoints during teardown. */
    }
  }
  const resolvedSessionDir =
    sessionDir ??
    (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null)
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir)
    } catch {
      /* Ignore non-empty or missing directories. */
    }
  }
}
