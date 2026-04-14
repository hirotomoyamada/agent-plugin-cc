import { spawn } from "node:child_process";
import process from "node:process";
import { AgentAppServerClient, BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./app-server.js";
import { loadBrokerSession } from "./broker-lifecycle.js";
import { readJsonFile } from "./fs.js";
import { binaryAvailable, runCommand } from "./process.js";

const SERVICE_NAME = "claude_code_agent_plugin";
const TASK_THREAD_PREFIX = "Agent Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

type ProgressCallback = ((eventOrMessage: any) => void) | null | undefined;

interface TurnCaptureState {
  threadId: string;
  rootThreadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  threadLabels: Map<string, string>;
  turnId: string | null;
  bufferedNotifications: any[];
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (value: TurnCaptureState) => void;
  rejectCompletion: (error: Error) => void;
  finalTurn: any;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  reviewText: string;
  reasoningSummary: string[];
  error: any;
  messages: any[];
  fileChanges: any[];
  commandExecutions: any[];
  onProgress: ProgressCallback;
}

interface ThreadOptions {
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  ephemeral?: boolean;
  threadName?: string | null;
}

interface ReviewRunOptions {
  model?: string | null;
  target?: any;
  delivery?: string;
  threadName?: string;
  onProgress?: ProgressCallback;
}

interface TaskRunOptions {
  resumeThreadId?: string | null;
  prompt?: string;
  defaultPrompt?: string;
  model?: string | null;
  effort?: string | null;
  sandbox?: string;
  onProgress?: ProgressCallback;
  persistThread?: boolean;
  threadName?: string | null;
  outputSchema?: any;
}

interface LogEventOptions {
  message?: string;
  phase?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
}

interface CaptureTurnOptions {
  onProgress?: ProgressCallback;
  onResponse?: (response: any, state: TurnCaptureState) => void;
}

interface AuthStatusResult {
  available: boolean;
  loggedIn: boolean;
  detail: string;
  source: string;
  authMethod: string | null;
  verified: boolean | null;
  provider: string | null;
}

interface InterruptResult {
  attempted: boolean;
  interrupted: boolean;
  transport: string | null;
  detail: string;
}

interface AvailabilityResult {
  available: boolean;
  detail: string;
}

interface RuntimeStatusResult {
  mode: string;
  label: string;
  detail: string;
  endpoint: string | null;
}

interface TurnResult {
  status: number;
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  reasoningSummary: string[];
  turn: any;
  error: any;
  stderr: string;
  fileChanges: any[];
  touchedFiles: string[];
  commandExecutions: any[];
}

interface ReviewResult {
  status: number;
  threadId: string;
  sourceThreadId: string;
  turnId: string | null;
  reviewText: string;
  reasoningSummary: string[];
  turn: any;
  error: any;
  stderr: string;
}

interface ParsedOutputResult {
  parsed: any;
  parseError: string | null;
  rawOutput: string;
  [key: string]: any;
}

function cleanAgentStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function buildThreadParams(cwd: string, options: ThreadOptions = {}): Record<string, any> {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    experimentalRawEvents: false
  };
}

function buildResumeParams(threadId: string, cwd: string, options: ThreadOptions = {}): Record<string, any> {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

function _buildTurnInput(prompt: string): Array<Record<string, any>> {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text: string | null | undefined, limit = 72): string {
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

function looksLikeVerificationCommand(command: string): boolean {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt: string): string {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message: any): string | null {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message: any): string | null {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function _collectTouchedFiles(fileChanges: any[]): string[] {
  const paths = new Set<string>();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text: any): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReasoningSections(value: any): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry: any) => extractReasoningSections(entry));
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

function mergeReasoningSections(existingSections: string[], nextSections: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

function emitProgress(
  onProgress: ProgressCallback,
  message: string | null | undefined,
  phase: string | null = null,
  extra: Record<string, any> = {}
): void {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress: ProgressCallback, options: LogEventOptions = {}): void {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state: TurnCaptureState, threadId: string | null): string | null {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state: TurnCaptureState, threadId: string | null, options: Record<string, any> = {}): void {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label: string | null =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state: TurnCaptureState, item: any): { message: string; phase: string } | null {
  switch (item.type) {
    case "enteredReviewMode":
      return {
        message: `Reviewer started: ${item.review}`,
        phase: "reviewing"
      };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return {
        message: `Applying ${item.changes.length} file change(s).`,
        phase: "editing"
      };
    case "mcpToolCall":
      return {
        message: `Calling ${item.server}/${item.tool}.`,
        phase: "investigating"
      };
    case "dynamicToolCall":
      return {
        message: `Running tool: ${item.tool}.`,
        phase: "investigating"
      };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map(
        (threadId: string) => labelForThread(state, threadId) ?? threadId
      );
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return {
        message: `Searching: ${shorten(item.query, 96)}`,
        phase: "investigating"
      };
    default:
      return null;
  }
}

function describeCompletedItem(state: TurnCaptureState, item: any): { message: string; phase: string } | null {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return {
        message: `Tool ${item.server}/${item.tool} ${item.status}.`,
        phase: "investigating"
      };
    case "dynamicToolCall":
      return {
        message: `Tool ${item.tool} ${item.status}.`,
        phase: "investigating"
      };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map(
        (threadId: string) => labelForThread(state, threadId) ?? threadId
      );
      const summary =
        subagents.length > 0
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

function createTurnCaptureState(threadId: string, options: { onProgress?: ProgressCallback } = {}): TurnCaptureState {
  let resolveCompletion!: (value: TurnCaptureState) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state: TurnCaptureState): void {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state: TurnCaptureState, turn: any = null, options: { inferred?: boolean } = {}): void {
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
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(
      state.onProgress,
      "Turn completion inferred after the main thread finished and subagent work drained.",
      "finalizing"
    );
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state: TurnCaptureState): void {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state: TurnCaptureState, message: any): boolean {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state: TurnCaptureState, item: any, lifecycle: string, threadId: string | null = null): void {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
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
      text: item.text ?? ""
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
          message: sourceLabel
            ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}`
            : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
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
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section: string) => `- ${section}`).join("\n")
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

function applyTurnNotification(state: TurnCaptureState, message: any): void {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
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
      emitProgress(state.onProgress, `Agent error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function _captureTurn(
  client: any,
  threadId: string,
  startRequest: () => Promise<any>,
  options: CaptureTurnOptions = {}
): Promise<TurnCaptureState> {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler: ((message: any) => void) | null = client.notificationHandler;

  client.setNotificationHandler((message: any) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
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
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer<T>(cwd: string, fn: (client: any) => Promise<T>): Promise<T> {
  let client: any = null;
  try {
    client = await AgentAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error: any) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient: any = await AgentAppServerClient.connect(cwd, {
      disableBroker: true
    });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function _startThread(client: any, cwd: string, options: ThreadOptions = {}): Promise<any> {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId: string = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", {
        threadId,
        name: options.threadName
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function _resumeThread(client: any, threadId: string, cwd: string, options: ThreadOptions = {}): Promise<any> {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function _buildResultStatus(turnState: TurnCaptureState): number {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

function buildAuthStatus(fields: Partial<AuthStatusResult> = {}): AuthStatusResult {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    provider: null,
    ...fields
  };
}

async function _getAgentAuthStatusFromClient(client: any, cwd: string): Promise<AuthStatusResult> {
  try {
    const accountResponse = await client.request("account/read", {
      refreshToken: false
    });
    const _configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    const account = accountResponse?.account ?? null;
    if (account) {
      const email: string | null =
        typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
      return buildAuthStatus({
        loggedIn: true,
        detail: email ? `Login active for ${email}` : "Login active",
        source: "app-server",
        authMethod: account.type ?? "unknown",
        verified: true
      });
    }

    return buildAuthStatus({
      loggedIn: false,
      detail: "Not authenticated",
      source: "app-server"
    });
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getAgentAvailability(cwd: string): AvailabilityResult {
  const versionStatus = binaryAvailable("agent", ["--version"], {
    cwd
  });
  if (!versionStatus.available) {
    return versionStatus;
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; print-mode runtime available`
  };
}

export function getSessionRuntimeStatus(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  cwd: string = process.cwd()
): RuntimeStatusResult {
  const endpoint: string | null = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Agent runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Agent runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getAgentAuthStatus(
  cwd: string,
  _options: { env?: Record<string, string | undefined> } = {}
): Promise<AuthStatusResult> {
  const availability = getAgentAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      provider: null
    };
  }

  try {
    const result = runCommand("agent", ["status", "--format", "json"], { cwd });
    if (result.status !== 0) {
      return buildAuthStatus({
        loggedIn: false,
        detail: result.stderr.trim() || `agent status exited with ${result.status}`,
        source: "agent-status"
      });
    }
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed.isAuthenticated) {
      const email: string | null = parsed.userInfo?.email ?? null;
      return buildAuthStatus({
        loggedIn: true,
        detail: email ? `Login active for ${email}` : "Login active",
        source: "agent-status",
        authMethod: "cursor-login",
        verified: true
      });
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: "Not authenticated",
      source: "agent-status"
    });
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "agent-status"
    });
  }
}

export async function interruptAppServerTurn(
  cwd: string,
  { threadId, turnId }: { threadId: string | null; turnId: string | null }
): Promise<InterruptResult> {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getAgentAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client: any = null;
  try {
    client = await AgentAppServerClient.connect(cwd, {
      reuseExistingBroker: true
    });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

async function runAgentPrintMode(
  cwd: string,
  prompt: string,
  options: {
    model?: string | null;
    sandbox?: string;
    onProgress?: ProgressCallback;
  } = {}
): Promise<TurnResult> {
  const args = ["--print", "--output-format", "json", "--trust"];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.sandbox === "full") {
    args.push("--yolo");
  }

  return new Promise<TurnResult>((resolve, reject) => {
    const proc = spawn("agent", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    proc.on("error", reject);
    proc.on("exit", () => {
      try {
        const result = JSON.parse(stdout.trim());
        emitProgress(options.onProgress, `Agent task ${result.is_error ? "failed" : "completed"}.`, "finalizing");
        resolve({
          status: result.is_error ? 1 : 0,
          threadId: result.session_id ?? "print-mode",
          turnId: result.request_id ?? null,
          finalMessage: result.result ?? "",
          reasoningSummary: [],
          turn: {
            id: result.request_id ?? "print-mode",
            status: result.is_error ? "failed" : "completed"
          },
          error: result.is_error ? { message: result.result } : null,
          stderr: cleanAgentStderr(stderr),
          fileChanges: [],
          touchedFiles: [],
          commandExecutions: []
        });
      } catch (_e) {
        reject(new Error(`Failed to parse agent output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

export async function runAppServerReview(cwd: string, options: ReviewRunOptions = {}): Promise<ReviewResult> {
  const availability = getAgentAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Cursor Agent CLI is not installed. Install Cursor IDE from https://www.cursor.com, then rerun `/agent:setup`."
    );
  }

  emitProgress(options.onProgress, "Starting Agent review (print mode).", "starting");

  const turnResult = await runAgentPrintMode(
    cwd,
    "Review the current changes in detail. Provide a thorough code review.",
    {
      model: options.model,
      sandbox: "read-only",
      onProgress: options.onProgress
    }
  );

  return {
    status: turnResult.status,
    threadId: turnResult.threadId,
    sourceThreadId: turnResult.threadId,
    turnId: turnResult.turnId,
    reviewText: turnResult.finalMessage,
    reasoningSummary: turnResult.reasoningSummary,
    turn: turnResult.turn,
    error: turnResult.error,
    stderr: turnResult.stderr
  };
}

export async function runAppServerTurn(cwd: string, options: TaskRunOptions = {}): Promise<TurnResult> {
  const availability = getAgentAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Cursor Agent CLI is not installed. Install Cursor IDE from https://www.cursor.com, then rerun `/agent:setup`."
    );
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Agent run.");
  }

  emitProgress(options.onProgress, "Starting Agent task (print mode).", "starting");

  return runAgentPrintMode(cwd, prompt, {
    model: options.model,
    sandbox: options.sandbox,
    onProgress: options.onProgress
  });
}

export async function findLatestTaskThread(cwd: string): Promise<any> {
  const availability = getAgentAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Cursor Agent CLI is not installed. Install Cursor IDE from https://www.cursor.com, then rerun `/agent:setup`."
    );
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find(
        (thread: any) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)
      ) ?? null
    );
  });
}

export function buildPersistentTaskThreadName(prompt: string): string {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(
  rawOutput: string | null | undefined,
  fallback: Record<string, any> = {}
): ParsedOutputResult {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Agent did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error: any) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath: string): any {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
