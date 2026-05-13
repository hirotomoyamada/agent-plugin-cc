import { spawn } from "node:child_process";
import process from "node:process";
import { BROKER_ENDPOINT_ENV, KimiAppServerClient, } from "./app-server.js";
import { loadBrokerSession } from "./broker-lifecycle.js";
import { binaryAvailable, runCommand } from "./process.js";
const TASK_THREAD_PREFIX = "Kimi Companion Task";
const DEFAULT_CONTINUE_PROMPT = "Continue from the current Kimi session and finish the requested task.";
export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
export function getKimiAvailability(_cwd) {
    if (!binaryAvailable("kimi")) {
        return {
            available: false,
            detail: "`kimi` binary was not found on PATH. Install with `pip install kimi-cli`.",
        };
    }
    const result = runCommand("kimi", ["--version"]);
    if (result.status !== 0) {
        return {
            available: false,
            detail: `\`kimi --version\` exited ${result.status}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}.`,
        };
    }
    return {
        available: true,
        detail: result.stdout.trim() || result.stderr.trim() || "ready",
    };
}
export function getKimiAuthStatus(_cwd) {
    const hasApiKey = Boolean(process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY);
    if (hasApiKey) {
        return {
            authenticated: true,
            detail: "API key present in environment.",
        };
    }
    return {
        authenticated: false,
        detail: "No KIMI_API_KEY or MOONSHOT_API_KEY found. Run `kimi login` or export the key.",
    };
}
export function getSessionRuntimeStatus(env, workspaceRoot) {
    const envBag = env ?? process.env;
    const inlineEndpoint = envBag[BROKER_ENDPOINT_ENV];
    if (inlineEndpoint) {
        return {
            detail: `Using broker endpoint ${inlineEndpoint}.`,
            endpoint: inlineEndpoint,
            label: "broker (env)",
            mode: "broker",
        };
    }
    const session = loadBrokerSession(workspaceRoot);
    if (session?.endpoint) {
        return {
            detail: `Persistent broker at ${session.endpoint}.`,
            endpoint: session.endpoint,
            label: "broker (persistent)",
            mode: "broker",
        };
    }
    return {
        detail: "No broker session. Each task spawns a fresh `kimi --wire`.",
        endpoint: null,
        label: "spawned",
        mode: "spawned",
    };
}
function pushContentPart(state, payload) {
    if (!payload || typeof payload !== "object") {
        return;
    }
    const part = payload;
    const partType = typeof part.type === "string" ? part.type : null;
    if (partType === "think") {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) {
            state.reasoningSummary.push(text);
        }
        return;
    }
    if (partType === "text") {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) {
            state.rawOutputParts.push(text);
        }
    }
}
function handleEventNotification(state, notification, progress) {
    if (!notification?.params) {
        return;
    }
    const params = notification.params;
    const eventType = typeof params.type === "string" ? params.type : null;
    const payload = params.payload && typeof params.payload === "object"
        ? params.payload
        : null;
    switch (eventType) {
        case "TurnBegin": {
            if (typeof payload?.turn_id === "string") {
                state.turnId = payload.turn_id;
            }
            if (typeof payload?.session_id === "string") {
                state.threadId = payload.session_id;
            }
            progress?.({
                message: "Kimi turn started",
                phase: "starting",
                threadId: state.threadId,
                turnId: state.turnId,
            });
            return;
        }
        case "StepBegin": {
            progress?.({ message: "Step started", phase: "running" });
            return;
        }
        case "ContentPart": {
            pushContentPart(state, payload);
            return;
        }
        case "ToolCall": {
            const name = typeof payload?.function === "object" && payload?.function !== null
                ? payload.function.name
                : undefined;
            progress?.({
                message: `Tool call: ${name ?? "(unknown)"}`,
                phase: "investigating",
            });
            return;
        }
        case "ToolResult": {
            progress?.({ message: "Tool result received", phase: "running" });
            return;
        }
        case "StatusUpdate": {
            progress?.({ message: "Status update", phase: "running" });
            return;
        }
        case "TurnEnd": {
            progress?.({ message: "Turn completed", phase: "finalizing" });
        }
    }
}
function buildAutoApprovalResponse(payload) {
    const requestId = typeof payload.id === "string" ? payload.id : `auto-${Date.now()}`;
    return { request_id: requestId, response: "approve_for_session" };
}
function buildAutoToolErrorResponse(payload) {
    const toolCallId = typeof payload.id === "string" ? payload.id : `auto-${Date.now()}`;
    return {
        return_value: {
            is_error: true,
            message: "External tool calls are not supported by this Claude Code plugin.",
            output: "",
        },
        tool_call_id: toolCallId,
    };
}
function buildAutoQuestionResponse(payload) {
    const requestId = typeof payload.id === "string" ? payload.id : `auto-${Date.now()}`;
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const answers = {};
    for (const question of questions) {
        if (!question || typeof question !== "object") {
            continue;
        }
        const q = question;
        const text = typeof q.question === "string" ? q.question : null;
        const options = Array.isArray(q.options) ? q.options : [];
        const firstLabel = options[0] &&
            typeof options[0] === "object" &&
            typeof options[0].label === "string"
            ? options[0].label
            : "";
        if (text) {
            answers[text] = firstLabel;
        }
    }
    return { answers, request_id: requestId };
}
function buildRejectApprovalResponse(payload) {
    const requestId = typeof payload.id === "string" ? payload.id : `auto-${Date.now()}`;
    return {
        feedback: "Read-only mode; tool calls that require approval are not allowed.",
        request_id: requestId,
        response: "reject",
    };
}
function handleServerRequest(message, respond, progress, writeMode) {
    if (message.method !== "request" || !message.params) {
        respond({
            error: {
                code: -32601,
                message: `Unsupported server request: ${message.method}`,
            },
        });
        return;
    }
    const requestType = typeof message.params.type === "string" ? message.params.type : null;
    const payload = message.params.payload && typeof message.params.payload === "object"
        ? message.params.payload
        : {};
    switch (requestType) {
        case "ApprovalRequest": {
            if (!writeMode) {
                progress?.({
                    message: "Rejecting approval request (read-only mode).",
                    phase: "running",
                });
                respond({ result: buildRejectApprovalResponse(payload) });
                return;
            }
            progress?.({
                message: "Auto-approving Kimi approval request.",
                phase: "running",
            });
            respond({ result: buildAutoApprovalResponse(payload) });
            return;
        }
        case "ToolCallRequest": {
            progress?.({
                message: "Rejecting unsupported external tool call.",
                phase: "running",
            });
            respond({ result: buildAutoToolErrorResponse(payload) });
            return;
        }
        case "QuestionRequest": {
            progress?.({
                message: "Auto-answering Kimi question with first option.",
                phase: "running",
            });
            respond({ result: buildAutoQuestionResponse(payload) });
            return;
        }
        default: {
            respond({
                error: {
                    code: -32601,
                    message: `Unsupported request type: ${requestType ?? "(missing)"}`,
                },
            });
        }
    }
}
export async function runKimiTurn(options, progress) {
    const state = {
        closeError: null,
        failureMessage: null,
        rawOutputParts: [],
        reasoningSummary: [],
        threadId: null,
        turnId: null,
    };
    const extraCliArgs = [];
    if (options.resumeId) {
        extraCliArgs.push("--resume", options.resumeId);
    }
    if (options.model) {
        extraCliArgs.push("--model", options.model);
    }
    if (options.write !== false) {
        extraCliArgs.push("--yolo");
    }
    const client = options.externalClient ??
        (await KimiAppServerClient.connect(options.cwd, {
            env: options.env,
            extraCliArgs,
            reuseExistingBroker: options.reuseExistingBroker,
        }));
    client.setNotificationHandler((message) => {
        if (message.method === "event") {
            handleEventNotification(state, message, progress);
        }
    });
    const writeMode = options.write !== false;
    client.setServerRequestHandler((message, respond) => {
        handleServerRequest(message, respond, progress, writeMode);
    });
    const abortHandler = () => {
        client.request("cancel", {}).catch(() => {
            /* Best-effort cancel. */
        });
    };
    if (options.signal) {
        if (options.signal.aborted) {
            abortHandler();
        }
        else {
            options.signal.addEventListener("abort", abortHandler, { once: true });
        }
    }
    try {
        const result = (await client.request("prompt", {
            user_input: options.prompt,
        }));
        const status = result && typeof result.status === "string" ? result.status : "finished";
        if (status === "cancelled") {
            state.failureMessage = "Kimi cancelled the turn before completion.";
            return {
                exitStatus: 130,
                failureMessage: state.failureMessage,
                rawOutput: state.rawOutputParts.join(""),
                reasoningSummary: state.reasoningSummary,
                threadId: state.threadId,
                turnId: state.turnId,
            };
        }
        return {
            exitStatus: 0,
            failureMessage: null,
            rawOutput: state.rawOutputParts.join(""),
            reasoningSummary: state.reasoningSummary,
            threadId: state.threadId,
            turnId: state.turnId,
        };
    }
    catch (error) {
        state.failureMessage =
            error instanceof Error ? error.message : String(error);
        return {
            exitStatus: 1,
            failureMessage: state.failureMessage,
            rawOutput: state.rawOutputParts.join(""),
            reasoningSummary: state.reasoningSummary,
            threadId: state.threadId,
            turnId: state.turnId,
        };
    }
    finally {
        if (options.signal && abortHandler) {
            options.signal.removeEventListener("abort", abortHandler);
        }
        if (!options.externalClient) {
            await client.close().catch(() => {
                /* Best-effort cleanup. */
            });
        }
    }
}
export async function interruptKimiTurn(cwd, options = {}) {
    try {
        const client = await KimiAppServerClient.connect(cwd, {
            env: options.env,
            reuseExistingBroker: true,
        });
        try {
            await client.request("cancel", {});
            return { delivered: true, detail: "Sent cancel to Kimi wire server." };
        }
        finally {
            await client.close().catch(() => {
                /* Best-effort cleanup. */
            });
        }
    }
    catch (error) {
        return {
            delivered: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function runKimiPrintMode(options) {
    const args = [
        "--print",
        "--output-format",
        "text",
        "--final-message-only",
        "-p",
        options.prompt,
    ];
    if (options.model) {
        args.push("--model", options.model);
    }
    if (options.yolo !== false) {
        args.push("--yolo");
    }
    options.onProgress?.({
        message: "Starting Kimi (print mode).",
        phase: "starting",
    });
    return new Promise((resolve, reject) => {
        const proc = spawn("kimi", args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        proc.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        if (options.signal) {
            const abortHandler = () => {
                proc.kill("SIGTERM");
            };
            if (options.signal.aborted) {
                abortHandler();
            }
            else {
                options.signal.addEventListener("abort", abortHandler, { once: true });
            }
        }
        proc.on("error", (error) => {
            reject(error);
        });
        proc.on("exit", (code) => {
            const finalMessage = stdout.trim();
            options.onProgress?.({
                message: `Kimi print mode ${code === 0 ? "completed" : "failed"}.`,
                phase: "finalizing",
            });
            resolve({
                exitStatus: code ?? 0,
                finalMessage,
                reasoningSummary: [],
                stderr: stderr.trim(),
                threadId: null,
            });
        });
    });
}
export async function runKimiReview(options) {
    const result = await runKimiPrintMode({
        cwd: options.cwd,
        env: options.env,
        model: options.model,
        onProgress: options.onProgress,
        prompt: options.prompt,
        signal: options.signal,
        yolo: true,
    });
    return {
        error: result.exitStatus === 0 ? null : { message: result.stderr },
        reasoningSummary: result.reasoningSummary,
        reviewText: result.finalMessage,
        status: result.exitStatus,
        stderr: result.stderr,
        threadId: result.threadId,
    };
}
export function buildPersistentTaskThreadName(prompt) {
    const trimmed = prompt.trim().replace(/\s+/g, " ");
    const head = trimmed.slice(0, 72);
    return `${TASK_THREAD_PREFIX}: ${head || "untitled"}`;
}
export function findLatestTaskThread(jobs) {
    for (const job of jobs) {
        if (job.kind !== "task") {
            continue;
        }
        if (typeof job.threadId !== "string" || !job.threadId.trim()) {
            continue;
        }
        return {
            jobId: typeof job.id === "string" ? job.id : "",
            name: typeof job.title === "string" && job.title.trim()
                ? job.title.trim()
                : TASK_THREAD_PREFIX,
            threadId: job.threadId,
            updatedAt: typeof job.updatedAt === "string"
                ? job.updatedAt
                : new Date().toISOString(),
        };
    }
    return null;
}
