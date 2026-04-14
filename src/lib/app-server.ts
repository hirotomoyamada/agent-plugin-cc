import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.js";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.js";
import { terminateProcessTree } from "./process.js";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8")) as { version?: string };

export const BROKER_ENDPOINT_ENV = "AGENT_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

interface ClientInfo {
  title: string;
  name: string;
  version: string;
}

interface Capabilities {
  experimentalApi: boolean;
  optOutNotificationMethods: string[];
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcRequest {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface AppServerClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: Capabilities;
  disableBroker?: boolean;
  brokerEndpoint?: string | null;
  reuseExistingBroker?: boolean;
}

interface BrokerClientOptions extends AppServerClientOptions {
  brokerEndpoint: string;
}

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: "Agent Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

const DEFAULT_CAPABILITIES: Capabilities = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message: string, data?: JsonRpcError): Error {
  const error = new Error(message);
  (error as any).data = data;
  if (data?.code !== undefined) {
    (error as any).rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  cwd: string;
  options: AppServerClientOptions;
  pending: Map<number, PendingRequest>;
  nextId: number;
  stderr: string;
  closed: boolean;
  exitError: Error | null;
  notificationHandler: ((message: JsonRpcRequest) => void) | null;
  lineBuffer: string;
  transport: string;
  exitPromise: Promise<void>;
  resolveExit!: (value: undefined) => void;
  exitResolved: boolean;

  constructor(cwd: string, options: AppServerClientOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.exitResolved = false;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler: (message: JsonRpcRequest) => void): void {
    this.notificationHandler = handler;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error("agent app-server client is closed.");
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk: string): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      this.handleExit(
        createProtocolError(`Failed to parse agent app-server JSONL: ${(error as Error).message}`, {
          code: -32700,
          message: (error as Error).message
        })
      );
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          createProtocolError(message.error.message ?? `agent app-server ${pending.method} failed.`, message.error)
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  handleServerRequest(message: JsonRpcRequest): void {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error: Error | null): void {
    if (this.exitResolved) {
      return;
    }
    this.exitResolved = true;
    this.exitError = error ?? null;
    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("agent app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  async close(): Promise<void> {
    this.handleExit(null);
    await this.exitPromise;
  }

  sendMessage(_message: JsonRpcRequest | { id?: number; error?: JsonRpcError }): void {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedAgentAppServerClient extends AppServerClientBase {
  proc: ChildProcess | null;
  readline: readline.Interface | null;

  constructor(cwd: string, options: AppServerClientOptions = {}) {
    super(cwd, options);
    this.transport = "direct";
    this.proc = null;
    this.readline = null;
  }

  async initialize(): Promise<void> {
    this.proc = spawn("agent", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? process.env.SHELL || true : false,
      windowsHide: true
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.proc.on("error", (error: Error) => {
      this.handleExit(error);
    });
    this.proc.on("exit", (code: number | null, signal: string | null) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `agent app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`
            );
      this.handleExit(detail);
    });
    this.readline = readline.createInterface({ input: this.proc.stdout! });
    this.readline.on("line", (line: string) => {
      this.handleLine(line);
    });
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    if (this.readline) {
      this.readline.close();
    }
    if (this.proc && !this.proc.killed) {
      this.proc.stdin!.end();
      const timer = setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid!);
            } catch {
              /* Best-effort cleanup */
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50);
      timer.unref?.();
    }
    await this.exitPromise;
  }

  sendMessage(message: JsonRpcRequest | { id?: number; error?: JsonRpcError }): void {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("agent app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerAgentAppServerClient extends AppServerClientBase {
  endpoint: string;
  socket: net.Socket | null;

  constructor(cwd: string, options: BrokerClientOptions) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
    this.socket = null;
  }

  async initialize(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", () => resolve());
      this.socket.on("data", (chunk: string) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error: Error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message: JsonRpcRequest | { id?: number; error?: JsonRpcError }): void {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("agent app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class AgentAppServerClient {
  static async connect(cwd: string, options: AppServerClientOptions = {}): Promise<AppServerClientBase> {
    let brokerEndpoint: string | null = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerAgentAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedAgentAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
