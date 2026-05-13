import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { BROKER_BUSY_RPC_CODE } from "./app-server.js";
import { parseArgs } from "./args.js";
import { parseBrokerEndpoint } from "./broker-endpoint.js";
function buildJsonRpcError(code, message, data) {
    return data === undefined ? { code, message } : { code, data, message };
}
function send(socket, message) {
    if (socket.destroyed) {
        return;
    }
    socket.write(`${JSON.stringify(message)}\n`);
}
function writePidFile(pidFile) {
    if (!pidFile) {
        return;
    }
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}
export async function runBrokerMain(options) {
    const { buildStreamThreadIds, config, connectClient, interruptMethod, shutdownMethod, streamCompletedMethod, streamingMethods, } = options;
    const [subcommand, ...argv] = process.argv.slice(2);
    if (subcommand !== "serve") {
        throw new Error("Usage: node dist/app-server-broker.js serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
    }
    const { options: parsedOptions } = parseArgs(argv, {
        valueOptions: ["cwd", "pid-file", "endpoint"],
    });
    if (!parsedOptions.endpoint) {
        throw new Error("Missing required --endpoint.");
    }
    const cwd = parsedOptions.cwd
        ? path.resolve(process.cwd(), String(parsedOptions.cwd))
        : process.cwd();
    const endpoint = String(parsedOptions.endpoint);
    const listenTarget = parseBrokerEndpoint(endpoint);
    const pidFile = parsedOptions["pid-file"]
        ? path.resolve(String(parsedOptions["pid-file"]))
        : null;
    writePidFile(pidFile);
    const appClient = await connectClient(cwd, { disableBroker: true });
    let activeRequestSocket = null;
    let activeStreamSocket = null;
    let activeStreamThreadIds = null;
    const sockets = new Set();
    function clearSocketOwnership(socket) {
        if (activeRequestSocket === socket) {
            activeRequestSocket = null;
        }
        if (activeStreamSocket === socket) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
        }
    }
    function routeNotification(message) {
        const target = activeRequestSocket ?? activeStreamSocket;
        if (!target) {
            return;
        }
        send(target, message);
        if (message.method === streamCompletedMethod &&
            activeStreamSocket === target) {
            const threadId = message.params?.threadId ?? null;
            if (!threadId ||
                !activeStreamThreadIds ||
                activeStreamThreadIds.has(threadId)) {
                activeStreamSocket = null;
                activeStreamThreadIds = null;
                if (activeRequestSocket === target) {
                    activeRequestSocket = null;
                }
            }
        }
    }
    async function shutdown(server) {
        for (const socket of sockets) {
            socket.end();
        }
        await appClient.close().catch(() => { });
        await new Promise((resolve) => server.close(() => resolve()));
        if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
            fs.unlinkSync(listenTarget.path);
        }
        if (pidFile && fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
        }
    }
    appClient.setNotificationHandler(routeNotification);
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", async (chunk) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
                if (!line.trim()) {
                    continue;
                }
                let message;
                try {
                    message = JSON.parse(line);
                }
                catch (error) {
                    send(socket, {
                        error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`),
                        id: null,
                    });
                    continue;
                }
                if (message.id !== undefined && message.method === "initialize") {
                    send(socket, {
                        id: message.id,
                        result: {
                            userAgent: config.appServer.userAgentLabel,
                        },
                    });
                    continue;
                }
                if (message.method === "initialized" && message.id === undefined) {
                    continue;
                }
                if (message.id !== undefined && message.method === shutdownMethod) {
                    send(socket, { id: message.id, result: {} });
                    await shutdown(server);
                    process.exit(0);
                }
                if (message.id === undefined) {
                    continue;
                }
                const isInterruptRequest = message?.method === interruptMethod;
                const allowInterruptDuringActiveStream = isInterruptRequest &&
                    activeStreamSocket &&
                    activeStreamSocket !== socket &&
                    !activeRequestSocket;
                if (((activeRequestSocket && activeRequestSocket !== socket) ||
                    (activeStreamSocket && activeStreamSocket !== socket)) &&
                    !allowInterruptDuringActiveStream) {
                    send(socket, {
                        error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, config.appServer.brokerBusyMessage),
                        id: message.id,
                    });
                    continue;
                }
                if (allowInterruptDuringActiveStream) {
                    try {
                        const result = await appClient.request(message.method, message.params ?? {});
                        send(socket, { id: message.id, result });
                    }
                    catch (error) {
                        send(socket, {
                            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message),
                            id: message.id,
                        });
                    }
                    continue;
                }
                const isStreaming = streamingMethods.has(message.method);
                activeRequestSocket = socket;
                try {
                    const result = await appClient.request(message.method, message.params ?? {});
                    send(socket, { id: message.id, result });
                    if (isStreaming) {
                        activeStreamSocket = socket;
                        activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
                    }
                    if (activeRequestSocket === socket) {
                        activeRequestSocket = null;
                    }
                }
                catch (error) {
                    send(socket, {
                        error: buildJsonRpcError(error.rpcCode ?? -32000, error.message),
                        id: message.id,
                    });
                    if (activeRequestSocket === socket) {
                        activeRequestSocket = null;
                    }
                    if (activeStreamSocket === socket && !isStreaming) {
                        activeStreamSocket = null;
                    }
                }
            }
        });
        socket.on("close", () => {
            sockets.delete(socket);
            clearSocketOwnership(socket);
        });
        socket.on("error", () => {
            sockets.delete(socket);
            clearSocketOwnership(socket);
        });
    });
    process.on("SIGTERM", async () => {
        await shutdown(server);
        process.exit(0);
    });
    process.on("SIGINT", async () => {
        await shutdown(server);
        process.exit(0);
    });
    server.listen(listenTarget.path);
}
