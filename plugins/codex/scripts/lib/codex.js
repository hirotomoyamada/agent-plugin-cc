import process from "node:process";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient, } from "./app-server.js";
import { loadBrokerSession } from "./broker-lifecycle.js";
import { readJsonFile } from "./fs.js";
import { binaryAvailable } from "./process.js";
const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
function cleanCodexStderr(stderr) {
    return stderr
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line &&
        !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
        .join("\n");
}
function buildThreadParams(cwd, options = {}) {
    return {
        approvalPolicy: options.approvalPolicy ?? "never",
        cwd,
        ephemeral: options.ephemeral ?? true,
        experimentalRawEvents: false,
        model: options.model ?? null,
        sandbox: options.sandbox ?? "read-only",
        serviceName: SERVICE_NAME,
    };
}
function buildResumeParams(threadId, cwd, options = {}) {
    return {
        approvalPolicy: options.approvalPolicy ?? "never",
        cwd,
        model: options.model ?? null,
        sandbox: options.sandbox ?? "read-only",
        threadId,
    };
}
function buildTurnInput(prompt) {
    return [{ text: prompt, text_elements: [], type: "text" }];
}
function shorten(text, limit = 72) {
    const normalized = String(text ?? "")
        .trim()
        .replace(/\s+/g, " ");
    if (!normalized) {
        return "";
    }
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit - 3)}...`;
}
function looksLikeVerificationCommand(command) {
    return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(command);
}
function buildTaskThreadName(prompt) {
    const excerpt = shorten(prompt, 56);
    return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}
function extractThreadId(message) {
    return message?.params?.threadId ?? null;
}
function extractTurnId(message) {
    if (message?.params?.turnId) {
        return message.params.turnId;
    }
    if (message?.params?.turn?.id) {
        return message.params.turn.id;
    }
    return null;
}
function collectTouchedFiles(fileChanges) {
    const paths = new Set();
    for (const fileChange of fileChanges) {
        for (const change of fileChange.changes ?? []) {
            if (change.path) {
                paths.add(change.path);
            }
        }
    }
    return [...paths];
}
function normalizeReasoningText(text) {
    return String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
}
function extractReasoningSections(value) {
    if (!value) {
        return [];
    }
    if (typeof value === "string") {
        const normalized = normalizeReasoningText(value);
        return normalized ? [normalized] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractReasoningSections(entry));
    }
    if (typeof value === "object") {
        if (typeof value.text === "string") {
            return extractReasoningSections(value.text);
        }
        if ("summary" in value) {
            return extractReasoningSections(value.summary);
        }
        if ("content" in value) {
            return extractReasoningSections(value.content);
        }
        if ("parts" in value) {
            return extractReasoningSections(value.parts);
        }
    }
    return [];
}
function mergeReasoningSections(existingSections, nextSections) {
    const merged = [];
    for (const section of [...existingSections, ...nextSections]) {
        const normalized = normalizeReasoningText(section);
        if (!normalized || merged.includes(normalized)) {
            continue;
        }
        merged.push(normalized);
    }
    return merged;
}
function emitProgress(onProgress, message, phase = null, extra = {}) {
    if (!onProgress || !message) {
        return;
    }
    if (!phase && Object.keys(extra).length === 0) {
        onProgress(message);
        return;
    }
    onProgress({ message, phase, ...extra });
}
function emitLogEvent(onProgress, options = {}) {
    if (!onProgress) {
        return;
    }
    onProgress({
        logBody: options.logBody ?? null,
        logTitle: options.logTitle ?? null,
        message: options.message ?? "",
        phase: options.phase ?? null,
        stderrMessage: options.stderrMessage ?? null,
    });
}
function labelForThread(state, threadId) {
    if (!threadId ||
        threadId === state.rootThreadId ||
        threadId === state.threadId) {
        return null;
    }
    return state.threadLabels.get(threadId) ?? threadId;
}
function registerThread(state, threadId, options = {}) {
    if (!threadId) {
        return;
    }
    state.threadIds.add(threadId);
    const label = options.threadName ??
        options.name ??
        options.agentNickname ??
        options.agentRole ??
        state.threadLabels.get(threadId) ??
        null;
    if (label) {
        state.threadLabels.set(threadId, label);
    }
}
function describeStartedItem(state, item) {
    switch (item.type) {
        case "enteredReviewMode":
            return {
                message: `Reviewer started: ${item.review}`,
                phase: "reviewing",
            };
        case "commandExecution":
            return {
                message: `Running command: ${shorten(item.command, 96)}`,
                phase: looksLikeVerificationCommand(item.command)
                    ? "verifying"
                    : "running",
            };
        case "fileChange":
            return {
                message: `Applying ${item.changes.length} file change(s).`,
                phase: "editing",
            };
        case "mcpToolCall":
            return {
                message: `Calling ${item.server}/${item.tool}.`,
                phase: "investigating",
            };
        case "dynamicToolCall":
            return {
                message: `Running tool: ${item.tool}.`,
                phase: "investigating",
            };
        case "collabAgentToolCall": {
            const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
            const summary = subagents.length > 0
                ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
                : `Starting collaboration tool: ${item.tool}.`;
            return { message: summary, phase: "investigating" };
        }
        case "webSearch":
            return {
                message: `Searching: ${shorten(item.query, 96)}`,
                phase: "investigating",
            };
        default:
            return null;
    }
}
function describeCompletedItem(state, item) {
    switch (item.type) {
        case "commandExecution": {
            const exitCode = item.exitCode ?? "?";
            const statusLabel = item.status === "completed" ? "completed" : item.status;
            return {
                message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
                phase: looksLikeVerificationCommand(item.command)
                    ? "verifying"
                    : "running",
            };
        }
        case "fileChange":
            return { message: `File changes ${item.status}.`, phase: "editing" };
        case "mcpToolCall":
            return {
                message: `Tool ${item.server}/${item.tool} ${item.status}.`,
                phase: "investigating",
            };
        case "dynamicToolCall":
            return {
                message: `Tool ${item.tool} ${item.status}.`,
                phase: "investigating",
            };
        case "collabAgentToolCall": {
            const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
            const summary = subagents.length > 0
                ? `Subagent ${subagents.join(", ")} ${item.status}.`
                : `Collaboration tool ${item.tool} ${item.status}.`;
            return { message: summary, phase: "investigating" };
        }
        case "exitedReviewMode":
            return { message: "Reviewer finished.", phase: "finalizing" };
        default:
            return null;
    }
}
function createTurnCaptureState(threadId, options = {}) {
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    return {
        activeSubagentTurns: new Set(),
        bufferedNotifications: [],
        commandExecutions: [],
        completed: false,
        completion,
        completionTimer: null,
        error: null,
        fileChanges: [],
        finalAnswerSeen: false,
        finalTurn: null,
        lastAgentMessage: "",
        messages: [],
        onProgress: options.onProgress ?? null,
        pendingCollaborations: new Set(),
        reasoningSummary: [],
        rejectCompletion,
        resolveCompletion,
        reviewText: "",
        rootThreadId: threadId,
        threadId,
        threadIds: new Set([threadId]),
        threadLabels: new Map(),
        threadTurnIds: new Map(),
        turnId: null,
    };
}
function clearCompletionTimer(state) {
    if (state.completionTimer) {
        clearTimeout(state.completionTimer);
        state.completionTimer = null;
    }
}
function completeTurn(state, turn = null, options = {}) {
    if (state.completed) {
        return;
    }
    clearCompletionTimer(state);
    state.completed = true;
    if (turn) {
        state.finalTurn = turn;
        if (!state.turnId) {
            state.turnId = turn.id;
        }
    }
    else if (!state.finalTurn) {
        state.finalTurn = {
            id: state.turnId ?? "inferred-turn",
            status: "completed",
        };
    }
    if (options.inferred) {
        emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
    }
    state.resolveCompletion(state);
}
function scheduleInferredCompletion(state) {
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
        return;
    }
    if (state.pendingCollaborations.size > 0 ||
        state.activeSubagentTurns.size > 0) {
        return;
    }
    clearCompletionTimer(state);
    state.completionTimer = setTimeout(() => {
        state.completionTimer = null;
        if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
            return;
        }
        if (state.pendingCollaborations.size > 0 ||
            state.activeSubagentTurns.size > 0) {
            return;
        }
        completeTurn(state, null, { inferred: true });
    }, 250);
    state.completionTimer.unref?.();
}
function belongsToTurn(state, message) {
    const messageThreadId = extractThreadId(message);
    if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
        return false;
    }
    const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
    const messageTurnId = extractTurnId(message);
    return (trackedTurnId === null ||
        messageTurnId === null ||
        messageTurnId === trackedTurnId);
}
function recordItem(state, item, lifecycle, threadId = null) {
    if (item.type === "collabAgentToolCall") {
        if (!threadId || threadId === state.threadId) {
            if (lifecycle === "started" || item.status === "inProgress") {
                state.pendingCollaborations.add(item.id);
            }
            else if (lifecycle === "completed") {
                state.pendingCollaborations.delete(item.id);
                scheduleInferredCompletion(state);
            }
        }
        for (const receiverThreadId of item.receiverThreadIds ?? []) {
            registerThread(state, receiverThreadId);
        }
    }
    if (item.type === "agentMessage") {
        state.messages.push({
            lifecycle,
            phase: item.phase ?? null,
            text: item.text ?? "",
        });
        if (item.text) {
            if (!threadId || threadId === state.threadId) {
                state.lastAgentMessage = item.text;
                if (lifecycle === "completed" && item.phase === "final_answer") {
                    state.finalAnswerSeen = true;
                    scheduleInferredCompletion(state);
                }
            }
            if (lifecycle === "completed") {
                const sourceLabel = labelForThread(state, threadId);
                emitLogEvent(state.onProgress, {
                    logBody: item.text,
                    logTitle: sourceLabel
                        ? `Subagent ${sourceLabel} message`
                        : "Assistant message",
                    message: sourceLabel
                        ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}`
                        : `Assistant message captured: ${shorten(item.text, 96)}`,
                    phase: item.phase === "final_answer" ? "finalizing" : null,
                    stderrMessage: null,
                });
            }
        }
        return;
    }
    if (item.type === "exitedReviewMode") {
        state.reviewText = item.review ?? "";
        if (lifecycle === "completed" && item.review) {
            emitLogEvent(state.onProgress, {
                logBody: item.review,
                logTitle: "Review output",
                message: "Review output captured.",
                phase: "finalizing",
                stderrMessage: null,
            });
        }
        return;
    }
    if (item.type === "reasoning" && lifecycle === "completed") {
        const nextSections = extractReasoningSections(item.summary);
        state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
        if (nextSections.length > 0) {
            const sourceLabel = labelForThread(state, threadId);
            emitLogEvent(state.onProgress, {
                logBody: nextSections
                    .map((section) => `- ${section}`)
                    .join("\n"),
                logTitle: sourceLabel
                    ? `Subagent ${sourceLabel} reasoning summary`
                    : "Reasoning summary",
                message: sourceLabel
                    ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
                    : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
                stderrMessage: null,
            });
        }
        return;
    }
    if (item.type === "fileChange" && lifecycle === "completed") {
        state.fileChanges.push(item);
        return;
    }
    if (item.type === "commandExecution" && lifecycle === "completed") {
        state.commandExecutions.push(item);
    }
}
function applyTurnNotification(state, message) {
    switch (message.method) {
        case "thread/started":
            registerThread(state, message.params.thread.id, {
                agentNickname: message.params.thread.agentNickname,
                agentRole: message.params.thread.agentRole,
                name: message.params.thread.name,
                threadName: message.params.thread.name,
            });
            break;
        case "thread/name/updated":
            registerThread(state, message.params.threadId, {
                threadName: message.params.threadName ?? null,
            });
            break;
        case "turn/started":
            registerThread(state, message.params.threadId);
            state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
            if ((message.params.threadId ?? null) !== state.threadId) {
                state.activeSubagentTurns.add(message.params.threadId);
            }
            emitProgress(state.onProgress, `Turn started (${message.params.turn.id}).`, "starting", (message.params.threadId ?? null) === state.threadId
                ? {
                    threadId: message.params.threadId ?? null,
                    turnId: message.params.turn.id ?? null,
                }
                : {});
            break;
        case "item/started":
            recordItem(state, message.params.item, "started", message.params.threadId ?? null);
            {
                const update = describeStartedItem(state, message.params.item);
                emitProgress(state.onProgress, update?.message, update?.phase ?? null);
            }
            break;
        case "item/completed":
            recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
            {
                const update = describeCompletedItem(state, message.params.item);
                emitProgress(state.onProgress, update?.message, update?.phase ?? null);
            }
            break;
        case "error":
            state.error = message.params.error;
            emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
            break;
        case "turn/completed":
            if ((message.params.threadId ?? null) !== state.threadId) {
                state.activeSubagentTurns.delete(message.params.threadId);
                scheduleInferredCompletion(state);
                break;
            }
            emitProgress(state.onProgress, `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`, "finalizing");
            completeTurn(state, message.params.turn);
            break;
        default:
            break;
    }
}
async function captureTurn(client, threadId, startRequest, options = {}) {
    const state = createTurnCaptureState(threadId, options);
    const previousHandler = client.notificationHandler;
    client.setNotificationHandler((message) => {
        if (!state.turnId) {
            state.bufferedNotifications.push(message);
            return;
        }
        if (message.method === "thread/started" ||
            message.method === "thread/name/updated") {
            applyTurnNotification(state, message);
            return;
        }
        if (!belongsToTurn(state, message)) {
            if (previousHandler) {
                previousHandler(message);
            }
            return;
        }
        applyTurnNotification(state, message);
    });
    try {
        const response = await startRequest();
        options.onResponse?.(response, state);
        state.turnId = response.turn?.id ?? null;
        if (state.turnId) {
            state.threadTurnIds.set(state.threadId, state.turnId);
        }
        for (const message of state.bufferedNotifications) {
            if (belongsToTurn(state, message)) {
                applyTurnNotification(state, message);
            }
            else if (previousHandler) {
                previousHandler(message);
            }
        }
        state.bufferedNotifications.length = 0;
        if (response.turn?.status && response.turn.status !== "inProgress") {
            completeTurn(state, response.turn);
        }
        return await state.completion;
    }
    finally {
        clearCompletionTimer(state);
        client.setNotificationHandler(previousHandler ?? null);
    }
}
async function withAppServer(cwd, fn) {
    let client = null;
    try {
        client = (await CodexAppServerClient.connect(cwd));
        const result = await fn(client);
        await client.close();
        return result;
    }
    catch (error) {
        const brokerRequested = client?.transport === "broker" ||
            Boolean(process.env[BROKER_ENDPOINT_ENV]);
        const shouldRetryDirect = (client?.transport === "broker" &&
            error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
            (brokerRequested &&
                (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));
        if (client) {
            await client.close().catch(() => { });
            client = null;
        }
        if (!shouldRetryDirect) {
            throw error;
        }
        const directClient = (await CodexAppServerClient.connect(cwd, {
            disableBroker: true,
        }));
        try {
            return await fn(directClient);
        }
        finally {
            await directClient.close();
        }
    }
}
async function startThread(client, cwd, options = {}) {
    const response = await client.request("thread/start", buildThreadParams(cwd, options));
    const threadId = response.thread.id;
    if (options.threadName) {
        try {
            await client.request("thread/name/set", {
                name: options.threadName,
                threadId,
            });
        }
        catch (err) {
            const msg = String(err?.message ?? err ?? "");
            if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
                throw err;
            }
        }
    }
    return response;
}
async function resumeThread(client, threadId, cwd, options = {}) {
    return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}
function buildResultStatus(turnState) {
    return turnState.finalTurn?.status === "completed" ? 0 : 1;
}
const BUILTIN_PROVIDER_LABELS = new Map([
    ["lmstudio", "LM Studio"],
    ["ollama", "Ollama"],
    ["openai", "OpenAI"],
]);
function normalizeProviderId(value) {
    const providerId = typeof value === "string" ? value.trim() : "";
    return providerId || null;
}
function formatProviderLabel(providerId, providerConfig = null) {
    const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
    if (configuredName) {
        return configuredName;
    }
    if (!providerId) {
        return "The active provider";
    }
    return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}
function buildAuthStatus(fields = {}) {
    return {
        authMethod: null,
        available: true,
        detail: "not authenticated",
        loggedIn: false,
        provider: null,
        requiresOpenaiAuth: null,
        source: "unknown",
        verified: null,
        ...fields,
    };
}
function resolveProviderConfig(configResponse) {
    const config = configResponse?.config;
    if (!config || typeof config !== "object") {
        return {
            providerConfig: null,
            providerId: null,
        };
    }
    const providerId = normalizeProviderId(config.model_provider);
    const providers = config.model_providers &&
        typeof config.model_providers === "object" &&
        !Array.isArray(config.model_providers)
        ? config.model_providers
        : null;
    const providerConfig = providerId &&
        providers?.[providerId] &&
        typeof providers[providerId] === "object"
        ? providers[providerId]
        : null;
    return {
        providerConfig,
        providerId,
    };
}
function buildAppServerAuthStatus(accountResponse, configResponse) {
    const account = accountResponse?.account ?? null;
    const requiresOpenaiAuth = typeof accountResponse?.requiresOpenaiAuth === "boolean"
        ? accountResponse.requiresOpenaiAuth
        : null;
    const { providerConfig, providerId } = resolveProviderConfig(configResponse);
    const providerLabel = formatProviderLabel(providerId, providerConfig);
    if (account?.type === "chatgpt") {
        const email = typeof account.email === "string" && account.email.trim()
            ? account.email.trim()
            : null;
        return buildAuthStatus({
            authMethod: "chatgpt",
            detail: email
                ? `ChatGPT login active for ${email}`
                : "ChatGPT login active",
            loggedIn: true,
            provider: providerId,
            requiresOpenaiAuth,
            source: "app-server",
            verified: true,
        });
    }
    if (account?.type === "apiKey") {
        return buildAuthStatus({
            authMethod: "apiKey",
            detail: "API key configured (unverified)",
            loggedIn: true,
            provider: providerId,
            requiresOpenaiAuth,
            source: "app-server",
            verified: false,
        });
    }
    if (requiresOpenaiAuth === false) {
        return buildAuthStatus({
            detail: `${providerLabel} is configured and does not require OpenAI authentication`,
            loggedIn: true,
            provider: providerId,
            requiresOpenaiAuth,
            source: "app-server",
        });
    }
    return buildAuthStatus({
        detail: `${providerLabel} requires OpenAI authentication`,
        loggedIn: false,
        provider: providerId,
        requiresOpenaiAuth,
        source: "app-server",
    });
}
async function getCodexAuthStatusFromClient(client, cwd) {
    try {
        const accountResponse = await client.request("account/read", {
            refreshToken: false,
        });
        const configResponse = await client.request("config/read", {
            cwd,
            includeLayers: false,
        });
        return buildAppServerAuthStatus(accountResponse, configResponse);
    }
    catch (error) {
        return buildAuthStatus({
            detail: error instanceof Error ? error.message : String(error),
            loggedIn: false,
            source: "app-server",
        });
    }
}
export function getCodexAvailability(cwd) {
    const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
    if (!versionStatus.available) {
        return versionStatus;
    }
    const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], {
        cwd,
    });
    if (!appServerStatus.available) {
        return {
            available: false,
            detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`,
        };
    }
    return {
        available: true,
        detail: `${versionStatus.detail}; advanced runtime available`,
    };
}
export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
    const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
    if (endpoint) {
        return {
            detail: "This Claude session is configured to reuse one shared Codex runtime.",
            endpoint,
            label: "shared session",
            mode: "shared",
        };
    }
    return {
        detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
        endpoint: null,
        label: "direct startup",
        mode: "direct",
    };
}
export async function getCodexAuthStatus(cwd, options = {}) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
        return {
            authMethod: null,
            available: false,
            detail: availability.detail,
            loggedIn: false,
            provider: null,
            requiresOpenaiAuth: null,
            source: "availability",
            verified: null,
        };
    }
    let client = null;
    try {
        client = (await CodexAppServerClient.connect(cwd, {
            env: options.env,
            reuseExistingBroker: true,
        }));
        return await getCodexAuthStatusFromClient(client, cwd);
    }
    catch (error) {
        return buildAuthStatus({
            detail: error instanceof Error ? error.message : String(error),
            loggedIn: false,
            source: "app-server",
        });
    }
    finally {
        if (client) {
            await client.close().catch(() => { });
        }
    }
}
export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
    if (!threadId || !turnId) {
        return {
            attempted: false,
            detail: "missing threadId or turnId",
            interrupted: false,
            transport: null,
        };
    }
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
        return {
            attempted: false,
            detail: availability.detail,
            interrupted: false,
            transport: null,
        };
    }
    let client = null;
    try {
        client = (await CodexAppServerClient.connect(cwd, {
            reuseExistingBroker: true,
        }));
        await client.request("turn/interrupt", { threadId, turnId });
        return {
            attempted: true,
            detail: `Interrupted ${turnId} on ${threadId}.`,
            interrupted: true,
            transport: client.transport,
        };
    }
    catch (error) {
        return {
            attempted: true,
            detail: error instanceof Error ? error.message : String(error),
            interrupted: false,
            transport: client?.transport ?? null,
        };
    }
    finally {
        await client?.close().catch(() => { });
    }
}
export async function runAppServerReview(cwd, options = {}) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
        throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
    }
    return withAppServer(cwd, async (client) => {
        emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
        const thread = await startThread(client, cwd, {
            ephemeral: true,
            model: options.model,
            sandbox: "read-only",
            threadName: options.threadName,
        });
        const sourceThreadId = thread.thread.id;
        emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", { threadId: sourceThreadId });
        const delivery = options.delivery ?? "inline";
        const turnState = await captureTurn(client, sourceThreadId, () => client.request("review/start", {
            delivery,
            target: options.target,
            threadId: sourceThreadId,
        }), {
            onProgress: options.onProgress,
            onResponse(response, state) {
                if (response.reviewThreadId) {
                    state.threadIds.add(response.reviewThreadId);
                    if (delivery === "detached") {
                        state.threadId = response.reviewThreadId;
                    }
                }
            },
        });
        return {
            error: turnState.error,
            reasoningSummary: turnState.reasoningSummary,
            reviewText: turnState.reviewText,
            sourceThreadId,
            status: buildResultStatus(turnState),
            stderr: cleanCodexStderr(client.stderr),
            threadId: turnState.threadId,
            turn: turnState.finalTurn,
            turnId: turnState.turnId,
        };
    });
}
export async function runAppServerTurn(cwd, options = {}) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
        throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
    }
    return withAppServer(cwd, async (client) => {
        let threadId;
        if (options.resumeThreadId) {
            emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
            const response = await resumeThread(client, options.resumeThreadId, cwd, {
                ephemeral: false,
                model: options.model,
                sandbox: options.sandbox,
            });
            threadId = response.thread.id;
        }
        else {
            emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
            const response = await startThread(client, cwd, {
                ephemeral: !options.persistThread,
                model: options.model,
                sandbox: options.sandbox,
                threadName: options.persistThread
                    ? options.threadName
                    : (options.threadName ?? null),
            });
            threadId = response.thread.id;
        }
        emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
            threadId,
        });
        const prompt = options.prompt?.trim() || options.defaultPrompt || "";
        if (!prompt) {
            throw new Error("A prompt is required for this Codex run.");
        }
        const turnState = await captureTurn(client, threadId, () => client.request("turn/start", {
            effort: options.effort ?? null,
            input: buildTurnInput(prompt),
            model: options.model ?? null,
            outputSchema: options.outputSchema ?? null,
            threadId,
        }), { onProgress: options.onProgress });
        return {
            commandExecutions: turnState.commandExecutions,
            error: turnState.error,
            fileChanges: turnState.fileChanges,
            finalMessage: turnState.lastAgentMessage,
            reasoningSummary: turnState.reasoningSummary,
            status: buildResultStatus(turnState),
            stderr: cleanCodexStderr(client.stderr),
            threadId,
            touchedFiles: collectTouchedFiles(turnState.fileChanges),
            turn: turnState.finalTurn,
            turnId: turnState.turnId,
        };
    });
}
export async function findLatestTaskThread(cwd) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available) {
        throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
    }
    return withAppServer(cwd, async (client) => {
        const response = await client.request("thread/list", {
            cwd,
            limit: 20,
            searchTerm: TASK_THREAD_PREFIX,
            sortKey: "updated_at",
            sourceKinds: ["appServer"],
        });
        return (response.data.find((thread) => typeof thread.name === "string" &&
            thread.name.startsWith(TASK_THREAD_PREFIX)) ?? null);
    });
}
export function buildPersistentTaskThreadName(prompt) {
    return buildTaskThreadName(prompt);
}
export function parseStructuredOutput(rawOutput, fallback = {}) {
    if (!rawOutput) {
        return {
            parsed: null,
            parseError: fallback.failureMessage ??
                "Codex did not return a final structured message.",
            rawOutput: rawOutput ?? "",
            ...fallback,
        };
    }
    try {
        return {
            parsed: JSON.parse(rawOutput),
            parseError: null,
            rawOutput,
            ...fallback,
        };
    }
    catch (error) {
        return {
            parsed: null,
            parseError: error.message,
            rawOutput,
            ...fallback,
        };
    }
}
export function readOutputSchema(schemaPath) {
    return readJsonFile(schemaPath);
}
export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
