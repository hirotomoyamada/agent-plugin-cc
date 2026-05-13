import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.js";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.js";
import { terminateProcessTree } from "./process.js";
const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
export const BROKER_ENDPOINT_ENV = "AGENT_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
const DEFAULT_CLIENT_INFO = {
    name: "Claude Code",
    title: "Agent Plugin",
    version: PLUGIN_MANIFEST.version ?? "0.0.0",
};
const DEFAULT_CAPABILITIES = {
    experimentalApi: false,
    optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta",
    ],
};
function buildJsonRpcError(code, message, data) {
    return data === undefined ? { code, message } : { code, data, message };
}
function createProtocolError(message, data) {
    const error = new Error(message);
    error.data = data;
    if (data?.code !== undefined) {
        ;
        error.rpcCode = data.code;
    }
    return error;
}
class AppServerClientBase {
    cwd;
    options;
    pending;
    nextId;
    stderr;
    closed;
    exitError;
    notificationHandler;
    lineBuffer;
    transport;
    exitPromise;
    resolveExit;
    exitResolved;
    constructor(cwd, options = {}) {
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
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
    }
    setNotificationHandler(handler) {
        this.notificationHandler = handler;
    }
    request(method, params) {
        if (this.closed) {
            throw new Error("agent app-server client is closed.");
        }
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, reject, resolve });
            this.sendMessage({ id, method, params });
        });
    }
    notify(method, params = {}) {
        if (this.closed) {
            return;
        }
        this.sendMessage({ method, params });
    }
    handleChunk(chunk) {
        this.lineBuffer += chunk;
        let newlineIndex = this.lineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = this.lineBuffer.slice(0, newlineIndex);
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
            this.handleLine(line);
            newlineIndex = this.lineBuffer.indexOf("\n");
        }
    }
    handleLine(line) {
        if (!line.trim()) {
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        }
        catch (error) {
            this.handleExit(createProtocolError(`Failed to parse agent app-server JSONL: ${error.message}`, {
                code: -32700,
                message: error.message,
            }));
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
                pending.reject(createProtocolError(message.error.message ??
                    `agent app-server ${pending.method} failed.`, message.error));
            }
            else {
                pending.resolve(message.result ?? {});
            }
            return;
        }
        if (message.method && this.notificationHandler) {
            this.notificationHandler(message);
        }
    }
    handleServerRequest(message) {
        this.sendMessage({
            error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`),
            id: message.id,
        });
    }
    handleExit(error) {
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
    async close() {
        this.handleExit(null);
        await this.exitPromise;
    }
    sendMessage(_message) {
        throw new Error("sendMessage must be implemented by subclasses.");
    }
}
class SpawnedAgentAppServerClient extends AppServerClientBase {
    proc;
    readline;
    constructor(cwd, options = {}) {
        super(cwd, options);
        this.transport = "direct";
        this.proc = null;
        this.readline = null;
    }
    async initialize() {
        this.proc = spawn("agent", ["app-server"], {
            cwd: this.cwd,
            env: this.options.env ?? process.env,
            shell: process.platform === "win32" ? process.env.SHELL || true : false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.proc.stdout.setEncoding("utf8");
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk) => {
            this.stderr += chunk;
        });
        this.proc.on("error", (error) => {
            this.handleExit(error);
        });
        this.proc.on("exit", (code, signal) => {
            const detail = code === 0
                ? null
                : createProtocolError(`agent app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
            this.handleExit(detail);
        });
        this.readline = readline.createInterface({ input: this.proc.stdout });
        this.readline.on("line", (line) => {
            this.handleLine(line);
        });
        await this.request("initialize", {
            capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
            clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        });
        this.notify("initialized", {});
    }
    async close() {
        if (this.closed) {
            await this.exitPromise;
            return;
        }
        this.closed = true;
        if (this.readline) {
            this.readline.close();
        }
        if (this.proc && !this.proc.killed) {
            this.proc.stdin.end();
            const timer = setTimeout(() => {
                if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
                    if (process.platform === "win32") {
                        try {
                            terminateProcessTree(this.proc.pid);
                        }
                        catch {
                            /* Best-effort cleanup */
                        }
                    }
                    else {
                        this.proc.kill("SIGTERM");
                    }
                }
            }, 50);
            timer.unref?.();
        }
        await this.exitPromise;
    }
    sendMessage(message) {
        const line = `${JSON.stringify(message)}\n`;
        const stdin = this.proc?.stdin;
        if (!stdin) {
            throw new Error("agent app-server stdin is not available.");
        }
        stdin.write(line);
    }
}
class BrokerAgentAppServerClient extends AppServerClientBase {
    endpoint;
    socket;
    constructor(cwd, options) {
        super(cwd, options);
        this.transport = "broker";
        this.endpoint = options.brokerEndpoint;
        this.socket = null;
    }
    async initialize() {
        await new Promise((resolve, reject) => {
            const target = parseBrokerEndpoint(this.endpoint);
            this.socket = net.createConnection({ path: target.path });
            this.socket.setEncoding("utf8");
            this.socket.on("connect", () => resolve());
            this.socket.on("data", (chunk) => {
                this.handleChunk(chunk);
            });
            this.socket.on("error", (error) => {
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
            capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
            clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        });
        this.notify("initialized", {});
    }
    async close() {
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
    sendMessage(message) {
        const line = `${JSON.stringify(message)}\n`;
        const socket = this.socket;
        if (!socket) {
            throw new Error("agent app-server broker connection is not connected.");
        }
        socket.write(line);
    }
}
export class AgentAppServerClient {
    static async connect(cwd, options = {}) {
        let brokerEndpoint = null;
        if (!options.disableBroker) {
            brokerEndpoint =
                options.brokerEndpoint ??
                    options.env?.[BROKER_ENDPOINT_ENV] ??
                    process.env[BROKER_ENDPOINT_ENV] ??
                    null;
            if (!brokerEndpoint && options.reuseExistingBroker) {
                brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
            }
            if (!brokerEndpoint && !options.reuseExistingBroker) {
                const brokerSession = await ensureBrokerSession(cwd, {
                    env: options.env,
                });
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
