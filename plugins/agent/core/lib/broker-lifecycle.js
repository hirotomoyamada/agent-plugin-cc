import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.js";
import { resolveStateDir } from "./state.js";
const BROKER_STATE_FILE = "broker.json";
export function createBrokerSessionDir(config, prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix ?? config.paths.brokerSessionPrefix));
}
function connectToEndpoint(endpoint) {
    const target = parseBrokerEndpoint(endpoint);
    return net.createConnection({ path: target.path });
}
export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await new Promise((resolve) => {
            const socket = connectToEndpoint(endpoint);
            socket.on("connect", () => {
                socket.end();
                resolve(true);
            });
            socket.on("error", () => resolve(false));
        });
        if (ready) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}
export async function sendBrokerShutdown(endpoint) {
    await new Promise((resolve) => {
        const socket = connectToEndpoint(endpoint);
        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
        });
        socket.on("data", () => {
            socket.end();
            resolve(undefined);
        });
        socket.on("error", () => resolve(undefined));
        socket.on("close", () => resolve(undefined));
    });
}
export function spawnBrokerProcess({ cwd, endpoint, env = process.env, logFile, pidFile, scriptPath, }) {
    const logFd = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [
        scriptPath,
        "serve",
        "--endpoint",
        endpoint,
        "--cwd",
        cwd,
        "--pid-file",
        pidFile,
    ], { cwd, detached: true, env, stdio: ["ignore", logFd, logFd] });
    child.unref();
    fs.closeSync(logFd);
    return child;
}
function resolveBrokerStateFile(config, cwd) {
    return path.join(resolveStateDir(config, cwd), BROKER_STATE_FILE);
}
export function loadBrokerSession(config, cwd) {
    const stateFile = resolveBrokerStateFile(config, cwd);
    if (!fs.existsSync(stateFile)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
    catch {
        return null;
    }
}
export function saveBrokerSession(config, cwd, session) {
    const stateDir = resolveStateDir(config, cwd);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(resolveBrokerStateFile(config, cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}
export function clearBrokerSession(config, cwd) {
    const stateFile = resolveBrokerStateFile(config, cwd);
    if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
    }
}
async function isBrokerEndpointReady(endpoint) {
    if (!endpoint) {
        return false;
    }
    try {
        return await waitForBrokerEndpoint(endpoint, 150);
    }
    catch {
        return false;
    }
}
export async function ensureBrokerSession(config, cwd, options) {
    const existing = loadBrokerSession(config, cwd);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
        return existing;
    }
    if (existing) {
        teardownBrokerSession({
            endpoint: existing.endpoint ?? null,
            killProcess: options.killProcess ?? null,
            logFile: existing.logFile ?? null,
            pid: existing.pid ?? null,
            pidFile: existing.pidFile ?? null,
            sessionDir: existing.sessionDir ?? null,
        });
        clearBrokerSession(config, cwd);
    }
    const sessionDir = createBrokerSessionDir(config);
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(config, sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const child = spawnBrokerProcess({
        cwd,
        endpoint,
        env: options.env ?? process.env,
        logFile,
        pidFile,
        scriptPath: options.scriptPath,
    });
    const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
    if (!ready) {
        teardownBrokerSession({
            endpoint,
            killProcess: options.killProcess ?? null,
            logFile,
            pid: child.pid ?? null,
            pidFile,
            sessionDir,
        });
        return null;
    }
    const session = {
        endpoint,
        logFile,
        pid: child.pid ?? null,
        pidFile,
        sessionDir,
    };
    saveBrokerSession(config, cwd, session);
    return session;
}
export function teardownBrokerSession({ endpoint = null, killProcess = null, logFile, pid = null, pidFile, sessionDir = null, }) {
    if (Number.isFinite(pid) && killProcess) {
        try {
            killProcess(pid);
        }
        catch {
            /* Ignore missing or already-exited broker processes. */
        }
    }
    if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
    }
    if (logFile && fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
    }
    if (endpoint) {
        try {
            const target = parseBrokerEndpoint(endpoint);
            if (target.kind === "unix" && fs.existsSync(target.path)) {
                fs.unlinkSync(target.path);
            }
        }
        catch {
            /* Ignore malformed or already-removed broker endpoints during teardown. */
        }
    }
    const resolvedSessionDir = sessionDir ??
        (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
    if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
        try {
            fs.rmdirSync(resolvedSessionDir);
        }
        catch {
            /* Ignore non-empty or missing directories. */
        }
    }
}
