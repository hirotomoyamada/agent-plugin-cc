import { type ChildProcess, spawn } from "node:child_process"
import net from "node:net"
import process from "node:process"
import readline from "node:readline"

import type { ProviderContext } from "./provider.js"
import { parseBrokerEndpoint } from "./broker-endpoint.js"
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.js"
import { terminateProcessTree } from "./process.js"

export const BROKER_BUSY_RPC_CODE = -32001

export interface ClientInfo {
  name: string
  title: string
  version: string
}

export interface Capabilities {
  experimentalApi: boolean
  optOutNotificationMethods: string[]
}

export interface JsonRpcError {
  code: number
  data?: unknown
  message: string
}

export interface JsonRpcMessage {
  error?: JsonRpcError
  id?: null | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

interface PendingRequest {
  method: string
  reject: (error: Error) => void
  resolve: (value: unknown) => void
}

export interface AppServerClientOptions {
  brokerEndpoint?: null | string
  brokerScriptPath?: string
  disableBroker?: boolean
  env?: NodeJS.ProcessEnv
  extraCliArgs?: string[]
  reuseExistingBroker?: boolean
}

interface BrokerClientOptions extends AppServerClientOptions {
  brokerEndpoint: string
}

function buildJsonRpcError(
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return data === undefined ? { code, message } : { code, data, message }
}

export function createProtocolError(
  message: string,
  data?: JsonRpcError,
): Error {
  const error = new Error(message)
  ;(error as any).data = data
  if (data?.code !== undefined) {
    ;(error as any).rpcCode = data.code
  }
  return error
}

export abstract class AppServerClientBase {
  config: ProviderContext
  cwd: string
  options: AppServerClientOptions
  pending: Map<number, PendingRequest>
  nextId: number
  stderr: string
  closed: boolean
  exitError: Error | null
  notificationHandler: ((message: JsonRpcMessage) => void) | null
  serverRequestHandler:
    | ((
        message: JsonRpcMessage,
        respond: (response: { error?: JsonRpcError; result?: unknown }) => void,
      ) => void)
    | null
  lineBuffer: string
  transport: string
  exitPromise: Promise<void>
  resolveExit!: (value: undefined) => void
  exitResolved: boolean

  constructor(
    config: ProviderContext,
    cwd: string,
    options: AppServerClientOptions = {},
  ) {
    this.config = config
    this.cwd = cwd
    this.options = options
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ""
    this.closed = false
    this.exitError = null
    this.notificationHandler = null
    this.serverRequestHandler = null
    this.lineBuffer = ""
    this.transport = "unknown"
    this.exitResolved = false
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve
    })
  }

  setNotificationHandler(handler: (message: JsonRpcMessage) => void): void {
    this.notificationHandler = handler
  }

  setServerRequestHandler(
    handler: (
      message: JsonRpcMessage,
      respond: (response: { error?: JsonRpcError; result?: unknown }) => void,
    ) => void,
  ): void {
    this.serverRequestHandler = handler
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error(
        `${this.config.appServer.cliBinary} app-server client is closed.`,
      )
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, reject, resolve })
      this.sendMessage({ id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) {
      return
    }
    this.sendMessage({ method, params })
  }

  handleChunk(chunk: string): void {
    this.lineBuffer += chunk
    let newlineIndex = this.lineBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex)
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)
      this.handleLine(line)
      newlineIndex = this.lineBuffer.indexOf("\n")
    }
  }

  handleLine(line: string): void {
    if (!line.trim()) {
      return
    }
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch (error) {
      this.handleExit(
        createProtocolError(
          `Failed to parse ${this.config.appServer.cliBinary} app-server JSONL: ${(error as Error).message}`,
          {
            code: -32700,
            message: (error as Error).message,
          },
        ),
      )
      return
    }
    if (message.id !== undefined && message.id !== null && message.method) {
      this.handleServerRequest(message)
      return
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          createProtocolError(
            message.error.message ??
              `${this.config.appServer.cliBinary} app-server ${pending.method} failed.`,
            message.error,
          ),
        )
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (message.method && this.notificationHandler) {
      this.notificationHandler(message)
    }
  }

  handleServerRequest(message: JsonRpcMessage): void {
    if (this.serverRequestHandler) {
      this.serverRequestHandler(message, (response) => {
        this.sendMessage({ ...response, id: message.id })
      })
      return
    }
    this.sendMessage({
      error: buildJsonRpcError(
        -32601,
        `Unsupported server request: ${message.method}`,
      ),
      id: message.id,
    })
  }

  handleExit(error: Error | null): void {
    if (this.exitResolved) {
      return
    }
    this.exitResolved = true
    this.exitError = error ?? null
    for (const pending of this.pending.values()) {
      pending.reject(
        this.exitError ??
          new Error(
            `${this.config.appServer.cliBinary} app-server connection closed.`,
          ),
      )
    }
    this.pending.clear()
    this.resolveExit(undefined)
  }

  async close(): Promise<void> {
    this.handleExit(null)
    await this.exitPromise
  }

  abstract initializeTransport(): Promise<void>

  abstract sendMessage(
    message: JsonRpcMessage | { error?: JsonRpcError; id?: null | number },
  ): void
}

export class SpawnedAppServerClient extends AppServerClientBase {
  proc: ChildProcess | null
  readline: null | readline.Interface

  constructor(
    config: ProviderContext,
    cwd: string,
    options: AppServerClientOptions = {},
  ) {
    super(config, cwd, options)
    this.transport = "direct"
    this.proc = null
    this.readline = null
  }

  async initializeTransport(): Promise<void> {
    const cliArgs = [
      ...this.config.appServer.cliArgs,
      ...(this.options.extraCliArgs ?? []),
    ]
    this.proc = spawn(this.config.appServer.cliBinary, cliArgs, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      shell: process.platform === "win32" ? process.env.SHELL || true : false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stderr!.setEncoding("utf8")
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk
    })
    this.proc.on("error", (error: Error) => {
      this.handleExit(error)
    })
    this.proc.on("exit", (code: null | number, signal: null | string) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `${this.config.appServer.cliBinary} app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`,
            )
      this.handleExit(detail)
    })
    this.readline = readline.createInterface({ input: this.proc.stdout! })
    this.readline.on("line", (line: string) => {
      this.handleLine(line)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise
      return
    }
    this.closed = true
    if (this.readline) {
      this.readline.close()
    }
    if (this.proc && !this.proc.killed) {
      this.proc.stdin!.end()
      const timer = setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid!)
            } catch {
              /* Best-effort cleanup */
            }
          } else {
            this.proc.kill("SIGTERM")
          }
        }
      }, 50)
      timer.unref?.()
    }
    await this.exitPromise
  }

  sendMessage(
    message: JsonRpcMessage | { error?: JsonRpcError; id?: null | number },
  ): void {
    const line = `${JSON.stringify(message)}\n`
    const stdin = this.proc?.stdin
    if (!stdin) {
      throw new Error(
        `${this.config.appServer.cliBinary} app-server stdin is not available.`,
      )
    }
    stdin.write(line)
  }
}

export class BrokerAppServerClient extends AppServerClientBase {
  endpoint: string
  socket: net.Socket | null

  constructor(
    config: ProviderContext,
    cwd: string,
    options: BrokerClientOptions,
  ) {
    super(config, cwd, options)
    this.transport = "broker"
    this.endpoint = options.brokerEndpoint
    this.socket = null
  }

  async initializeTransport(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint)
      this.socket = net.createConnection({ path: target.path })
      this.socket.setEncoding("utf8")
      this.socket.on("connect", () => resolve())
      this.socket.on("data", (chunk: string) => {
        this.handleChunk(chunk)
      })
      this.socket.on("error", (error: Error) => {
        if (!this.exitResolved) {
          reject(error)
        }
        this.handleExit(error)
      })
      this.socket.on("close", () => {
        this.handleExit(this.exitError)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise
      return
    }
    this.closed = true
    if (this.socket) {
      this.socket.end()
    }
    await this.exitPromise
  }

  sendMessage(
    message: JsonRpcMessage | { error?: JsonRpcError; id?: null | number },
  ): void {
    const line = `${JSON.stringify(message)}\n`
    const socket = this.socket
    if (!socket) {
      throw new Error(
        `${this.config.appServer.cliBinary} app-server broker connection is not connected.`,
      )
    }
    socket.write(line)
  }
}

export async function resolveBrokerEndpoint(
  config: ProviderContext,
  cwd: string,
  options: AppServerClientOptions,
): Promise<null | string> {
  if (options.disableBroker) {
    return null
  }
  const fromOptions =
    options.brokerEndpoint ??
    options.env?.[config.envVars.brokerEndpoint] ??
    process.env[config.envVars.brokerEndpoint] ??
    null
  if (fromOptions) {
    return fromOptions
  }
  if (options.reuseExistingBroker) {
    return loadBrokerSession(config, cwd)?.endpoint ?? null
  }
  if (!options.brokerScriptPath) {
    return null
  }
  const session = await ensureBrokerSession(config, cwd, {
    env: options.env,
    scriptPath: options.brokerScriptPath,
  })
  return session?.endpoint ?? null
}

export async function connectAppServer(
  config: ProviderContext,
  cwd: string,
  options: AppServerClientOptions = {},
): Promise<AppServerClientBase> {
  const brokerEndpoint = await resolveBrokerEndpoint(config, cwd, options)
  const client = brokerEndpoint
    ? new BrokerAppServerClient(config, cwd, { ...options, brokerEndpoint })
    : new SpawnedAppServerClient(config, cwd, options)
  await client.initializeTransport()
  return client
}
