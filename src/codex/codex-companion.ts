import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { parseArgs, splitRawArgumentString } from "./lib/args.js"
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
  interruptAppServerTurn,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn,
} from "./lib/codex.js"
import { readStdinIfPiped } from "./lib/fs.js"
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
} from "./lib/git.js"
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
} from "./lib/job-control.js"
import { binaryAvailable, terminateProcessTree } from "./lib/process.js"
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.js"
import {
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
} from "./lib/render.js"
import {
  generateJobId,
  getConfig,
  type JobRecord,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile,
} from "./lib/state.js"
import { coerceString } from "./lib/strings.js"
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  type ProgressReporter,
  runTrackedJob,
  SESSION_ID_ENV,
} from "./lib/tracked-jobs.js"
import { resolveWorkspaceRoot } from "./lib/workspace.js"

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const REVIEW_SCHEMA = path.join(
  ROOT_DIR,
  "schemas",
  "review-output.schema.json",
)
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000
const VALID_REASONING_EFFORTS = new Set([
  "high",
  "low",
  "medium",
  "minimal",
  "none",
  "xhigh",
])
const MODEL_ALIASES = new Map<string, string>([
  ["spark", "gpt-5.3-codex-spark"],
])
const STOP_REVIEW_TASK_MARKER =
  "Run a stop-gate review of the previous Claude turn."

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.js setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.js review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.js adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.js task [--background] [--write] [--resume-last|--resume|--resume-id <threadId>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.js status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.js result [job-id] [--json]",
      "  node scripts/codex-companion.js cancel [job-id] [--json]",
    ].join("\n"),
  )
}

function outputResult(value: any, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2))
  } else {
    process.stdout.write(value)
  }
}

function outputCommandResult(
  payload: any,
  rendered: string,
  asJson: boolean,
): void {
  outputResult(asJson ? payload : rendered, asJson)
}

function normalizeRequestedModel(model: unknown): null | string {
  const normalized = coerceString(model).trim()
  if (!normalized) {
    return null
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized
}

function normalizeReasoningEffort(effort: unknown): null | string {
  const raw = coerceString(effort)
  const normalized = raw.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${raw}". Use one of: none, minimal, low, medium, high, xhigh.`,
    )
  }
  return normalized
}

function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 1) {
    const raw = argv[0]
    if (!raw || !raw.trim()) {
      return []
    }
    return splitRawArgumentString(raw)
  }
  return argv
}

interface ParseInputConfig {
  aliasMap?: Record<string, string>
  booleanOptions?: string[]
  valueOptions?: string[]
}

function parseCommandInput(argv: string[], config: ParseInputConfig = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...config.aliasMap,
    },
  })
}

function resolveCommandCwd(options: Record<string, any> = {}): string {
  return options.cwd
    ? path.resolve(process.cwd(), options.cwd as string)
    : process.cwd()
}

function resolveCommandWorkspace(options: Record<string, any> = {}): string {
  return resolveWorkspaceRoot(resolveCommandCwd(options))
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function shorten(text: unknown, limit = 96): string {
  const normalized = coerceString(text).trim().replace(/\s+/g, " ")
  if (!normalized) {
    return ""
  }
  if (normalized.length <= limit) {
    return normalized
  }
  return `${normalized.slice(0, limit - 3)}...`
}

function firstMeaningfulLine(text: unknown, fallback: string): string {
  const line = coerceString(text)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  return line ?? fallback
}

async function buildSetupReport(
  cwd: string,
  actionsTaken: string[] = [],
): Promise<Record<string, any>> {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd })
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd })
  const codexStatus = getCodexAvailability(cwd)
  const authStatus = await getCodexAuthStatus(cwd)
  const config = getConfig(workspaceRoot)

  const nextSteps: string[] = []
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.")
  }
  if (
    codexStatus.available &&
    !authStatus.loggedIn &&
    authStatus.requiresOpenaiAuth
  ) {
    nextSteps.push("Run `!codex login`.")
    nextSteps.push(
      "If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.",
    )
  }
  if (!config.stopReviewGate) {
    nextSteps.push(
      "Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.",
    )
  }

  return {
    actionsTaken,
    auth: authStatus,
    codex: codexStatus,
    nextSteps,
    node: nodeStatus,
    npm: npmStatus,
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
  }
}

async function handleSetup(argv: string[]): Promise<void> {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
    valueOptions: ["cwd"],
  })

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error(
      "Choose either --enable-review-gate or --disable-review-gate.",
    )
  }

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const actionsTaken: string[] = []

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true)
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`)
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false)
    actionsTaken.push(
      `Disabled the stop-time review gate for ${workspaceRoot}.`,
    )
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken)
  outputResult(
    options.json ? finalReport : renderSetupReport(finalReport),
    Boolean(options.json),
  )
}

function buildAdversarialReviewPrompt(context: any, focusText: string): string {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review")
  return interpolateTemplate(template, {
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
  })
}

function ensureCodexAvailable(cwd: string): void {
  const availability = getCodexAvailability(cwd)
  if (!availability.available) {
    throw new Error(
      "Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.",
    )
  }
}

function buildNativeReviewTarget(target: any): null | Record<string, any> {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" }
  }
  if (target.mode === "branch") {
    return { branch: target.baseRef, type: "baseBranch" }
  }
  return null
}

function validateNativeReviewRequest(
  target: any,
  focusText: string,
): Record<string, any> {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`,
    )
  }

  const nativeTarget = buildNativeReviewTarget(target)
  if (!nativeTarget) {
    throw new Error(
      "This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.",
    )
  }
  return nativeTarget
}

function renderStatusPayload(report: any, asJson: boolean): any {
  return asJson ? report : renderStatusReport(report)
}

function isActiveJobStatus(status: unknown): boolean {
  return status === "queued" || status === "running"
}

function getCurrentClaudeSessionId(): null | string {
  return process.env[SESSION_ID_ENV] ?? null
}

function filterJobsForCurrentClaudeSession(jobs: JobRecord[]): JobRecord[] {
  const sessionId = getCurrentClaudeSessionId()
  if (!sessionId) {
    return jobs
  }
  return jobs.filter((job) => job.sessionId === sessionId)
}

function findLatestResumableTaskJob(jobs: JobRecord[]): JobRecord | null {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        Boolean(job.threadId) &&
        job.status !== "queued" &&
        job.status !== "running",
    ) ?? null
  )
}

interface WaitSnapshotOptions {
  pollIntervalMs?: number | string
  timeoutMs?: number | string
}

async function waitForSingleJobSnapshot(
  cwd: string,
  reference: string,
  options: WaitSnapshotOptions = {},
): Promise<any> {
  const timeoutMs = Math.max(
    0,
    Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  )
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS,
  )
  const deadline = Date.now() + timeoutMs
  let snapshot = buildSingleJobSnapshot(cwd, reference)

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
    snapshot = buildSingleJobSnapshot(cwd, reference)
  }

  return {
    ...snapshot,
    timeoutMs,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
  }
}

async function resolveLatestTrackedTaskThread(
  cwd: string,
  options: { excludeJobId?: string } = {},
): Promise<any> {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const sessionId = getCurrentClaudeSessionId()
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.id !== options.excludeJobId,
  )
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs)
  const activeTask = visibleJobs.find(
    (job) =>
      job.jobClass === "task" &&
      (job.status === "queued" || job.status === "running"),
  )
  if (activeTask) {
    throw new Error(
      `Task ${activeTask.id} is still running. Use /codex:status before continuing it.`,
    )
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs)
  if (trackedTask) {
    return { id: trackedTask.threadId }
  }

  if (sessionId) {
    return null
  }

  return findLatestTaskThread(workspaceRoot)
}

interface ReviewRunRequest {
  base?: null | string
  cwd: string
  focusText?: string
  model?: null | string
  onProgress?: ProgressReporter
  reviewName?: string
  scope?: null | string
}

async function executeReviewRun(request: ReviewRunRequest): Promise<any> {
  ensureCodexAvailable(request.cwd)
  ensureGitRepository(request.cwd)

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope ?? undefined,
  })
  const focusText = request.focusText?.trim() ?? ""
  const reviewName = request.reviewName ?? "Review"
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText)
    const result = await runAppServerReview(request.cwd, {
      model: request.model,
      onProgress: request.onProgress,
      target: reviewTarget,
    })
    const payload = {
      codex: {
        reasoning: result.reasoningSummary,
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
      },
      review: reviewName,
      sourceThreadId: result.sourceThreadId,
      target,
      threadId: result.threadId,
    }
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
      },
      {
        reasoningSummary: result.reasoningSummary,
        reviewLabel: reviewName,
        targetLabel: target.label,
      },
    )

    return {
      exitStatus: result.status,
      jobClass: "review",
      jobTitle: `Codex ${reviewName}`,
      payload,
      rendered,
      summary: firstMeaningfulLine(
        result.reviewText,
        `${reviewName} completed.`,
      ),
      targetLabel: target.label,
      threadId: result.threadId,
      turnId: result.turnId,
    }
  }

  const context = collectReviewContext(request.cwd, target)
  const prompt = buildAdversarialReviewPrompt(context, focusText)
  const result = await runAppServerTurn(context.repoRoot, {
    model: request.model,
    onProgress: request.onProgress,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    prompt,
    sandbox: "read-only",
  })
  const parsed = parseStructuredOutput(result.finalMessage, {
    failureMessage: result.error?.message ?? result.stderr,
    status: result.status,
  })
  const payload = {
    codex: {
      reasoning: result.reasoningSummary,
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
    },
    context: {
      branch: context.branch,
      repoRoot: context.repoRoot,
      summary: context.summary,
    },
    parseError: parsed.parseError,
    rawOutput: parsed.rawOutput,
    reasoningSummary: result.reasoningSummary,
    result: parsed.parsed,
    review: reviewName,
    target,
    threadId: result.threadId,
  }

  return {
    exitStatus: result.status,
    jobClass: "review",
    jobTitle: `Codex ${reviewName}`,
    payload,
    rendered: renderReviewResult(parsed, {
      reasoningSummary: result.reasoningSummary,
      reviewLabel: reviewName,
      targetLabel: context.target.label,
    }),
    summary:
      parsed.parsed?.summary ??
      parsed.parseError ??
      firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    targetLabel: context.target.label,
    threadId: result.threadId,
    turnId: result.turnId,
  }
}

interface TaskRunRequest {
  cwd: string
  effort?: null | string
  jobId?: null | string
  model?: null | string
  onProgress?: ProgressReporter
  prompt?: string
  resumeId?: null | string
  resumeLast?: boolean
  write?: boolean
}

async function executeTaskRun(request: TaskRunRequest): Promise<any> {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd)
  ensureCodexAvailable(request.cwd)

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast || Boolean(request.resumeId),
  })

  let resumeThreadId: null | string = null
  if (request.resumeId) {
    resumeThreadId = request.resumeId
  } else if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId ?? undefined,
    })
    if (!latestThread) {
      throw new Error(
        "No previous Codex task thread was found for this repository.",
      )
    }
    resumeThreadId = latestThread.id
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
    )
  }

  const result = await runAppServerTurn(workspaceRoot, {
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    effort: request.effort,
    model: request.model,
    onProgress: request.onProgress,
    persistThread: true,
    prompt: request.prompt,
    resumeThreadId,
    sandbox: request.write ? "workspace-write" : "read-only",
    threadName: resumeThreadId
      ? null
      : buildPersistentTaskThreadName(
          request.prompt || DEFAULT_CONTINUE_PROMPT,
        ),
  })

  const rawOutput =
    typeof result.finalMessage === "string" ? result.finalMessage : ""
  const failureMessage = result.error?.message ?? result.stderr ?? ""
  const rendered = renderTaskResult(
    {
      failureMessage,
      rawOutput,
      reasoningSummary: result.reasoningSummary,
    },
    {
      jobId: request.jobId ?? null,
      title: taskMetadata.title,
      write: Boolean(request.write),
    },
  )
  const payload = {
    rawOutput,
    reasoningSummary: result.reasoningSummary,
    status: result.status,
    threadId: result.threadId,
    touchedFiles: result.touchedFiles,
  }

  return {
    exitStatus: result.status,
    jobClass: "task",
    jobTitle: taskMetadata.title,
    payload,
    rendered,
    summary: firstMeaningfulLine(
      rawOutput,
      firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`),
    ),
    threadId: result.threadId,
    turnId: result.turnId,
    write: Boolean(request.write),
  }
}

function buildReviewJobMetadata(reviewName: string, target: any) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    summary: `${reviewName} ${target.label}`,
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
  }
}

interface TaskRunMetadataInput {
  prompt?: string
  resumeLast?: boolean
}

function buildTaskRunMetadata({
  prompt,
  resumeLast = false,
}: TaskRunMetadataInput) {
  if (!resumeLast && coerceString(prompt).includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      summary: "Stop-gate review of previous Claude turn",
      title: "Codex Stop Gate Review",
    }
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task"
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task"
  return {
    summary: shorten(prompt || fallbackSummary),
    title,
  }
}

function renderQueuedTaskLaunch(payload: Record<string, any>): string {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`
}

function getJobKindLabel(kind: string, jobClass: string): string {
  if (kind === "adversarial-review") {
    return "adversarial-review"
  }
  return jobClass === "review" ? "review" : "rescue"
}

interface CompanionJobInput {
  jobClass: string
  kind: string
  prefix: string
  summary: string
  title: string
  workspaceRoot: string
  write?: boolean
}

function createCompanionJob({
  jobClass,
  kind,
  prefix,
  summary,
  title,
  workspaceRoot,
  write = false,
}: CompanionJobInput): Record<string, any> {
  return createJobRecord({
    id: generateJobId(prefix),
    jobClass,
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    summary,
    title,
    workspaceRoot,
    write,
  })
}

interface TrackedProgressOptions {
  logFile?: null | string
  stderr?: boolean
}

function createTrackedProgress(
  job: Record<string, any>,
  options: TrackedProgressOptions = {},
): { logFile: string; progress: ProgressReporter } {
  const logFile =
    options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title)
  return {
    logFile,
    progress: createProgressReporter({
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
      stderr: Boolean(options.stderr),
    }),
  }
}

function buildTaskJob(
  workspaceRoot: string,
  taskMetadata: { summary: string; title: string },
  write: boolean,
): Record<string, any> {
  return createCompanionJob({
    jobClass: "task",
    kind: "task",
    prefix: "task",
    summary: taskMetadata.summary,
    title: taskMetadata.title,
    workspaceRoot,
    write,
  })
}

interface TaskRequestInput {
  cwd: string
  effort: null | string
  jobId: string
  model: null | string
  prompt: string
  resumeId: null | string
  resumeLast: boolean
  write: boolean
}

function buildTaskRequest({
  cwd,
  effort,
  jobId,
  model,
  prompt,
  resumeId,
  resumeLast,
  write,
}: TaskRequestInput) {
  return { cwd, effort, jobId, model, prompt, resumeId, resumeLast, write }
}

function readTaskPrompt(
  cwd: string,
  options: Record<string, any>,
  positionals: string[],
): string {
  if (options["prompt-file"]) {
    return fs.readFileSync(
      path.resolve(cwd, options["prompt-file"] as string),
      "utf8",
    )
  }
  const positionalPrompt = positionals.join(" ")
  return positionalPrompt || readStdinIfPiped()
}

function requireTaskRequest(prompt: string, resumeLast: boolean): void {
  if (!prompt && !resumeLast) {
    throw new Error(
      "Provide a prompt, a prompt file, piped stdin, or use --resume-last.",
    )
  }
}

interface ForegroundOptions {
  json?: boolean
  logFile?: null | string
}

async function runForegroundCommand(
  job: Record<string, any>,
  runner: (progress: ProgressReporter) => Promise<any>,
  options: ForegroundOptions = {},
): Promise<any> {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json,
  })
  const execution = await runTrackedJob(
    {
      ...job,
      id: job.id as string,
      logFile,
      workspaceRoot: job.workspaceRoot as string,
    },
    () => runner(progress),
    { logFile },
  )
  outputResult(
    options.json ? execution.payload : execution.rendered,
    Boolean(options.json),
  )
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus
  }
  return execution
}

function spawnDetachedTaskWorker(cwd: string, jobId: string) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.js")
  const child = spawn(
    process.execPath,
    [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId],
    {
      cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  )
  child.unref()
  return child
}

function enqueueBackgroundTask(
  cwd: string,
  job: Record<string, any>,
  request: Record<string, any>,
): { logFile: string; payload: Record<string, any> } {
  const { logFile } = createTrackedProgress(job)
  appendLogLine(logFile, "Queued for background execution.")

  const child = spawnDetachedTaskWorker(cwd, job.id as string)
  const queuedRecord = {
    ...job,
    logFile,
    phase: "queued",
    pid: child.pid ?? null,
    request,
    status: "queued",
  }
  writeJobFile(job.workspaceRoot as string, job.id as string, queuedRecord)
  upsertJob(job.workspaceRoot as string, {
    id: job.id as string,
    ...queuedRecord,
  })

  return {
    logFile,
    payload: {
      jobId: job.id,
      logFile,
      status: "queued",
      summary: job.summary,
      title: job.title,
    },
  }
}

interface ReviewCommandConfig {
  reviewName: string
  validateRequest?: (target: any, focusText: string) => void
}

async function handleReviewCommand(
  argv: string[],
  config: ReviewCommandConfig,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    aliasMap: { m: "model" },
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["base", "scope", "model", "cwd"],
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const focusText = positionals.join(" ").trim()
  const target = resolveReviewTarget(cwd, {
    base: options.base as null | string,
    scope: options.scope as string | undefined,
  })

  config.validateRequest?.(target, focusText)
  const metadata = buildReviewJobMetadata(config.reviewName, target)
  const job = createCompanionJob({
    jobClass: "review",
    kind: metadata.kind,
    prefix: "review",
    summary: metadata.summary,
    title: metadata.title,
    workspaceRoot,
  })
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        base: options.base as null | string,
        cwd,
        focusText,
        model: normalizeRequestedModel(options.model),
        onProgress: progress,
        reviewName: config.reviewName,
        scope: options.scope as null | string,
      }),
    { json: Boolean(options.json) },
  )
}

async function handleReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest,
  })
}

async function handleTask(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    aliasMap: { m: "model" },
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
    ],
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-id"],
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const model = normalizeRequestedModel(options.model)
  const effort = normalizeReasoningEffort(options.effort)
  const prompt = readTaskPrompt(cwd, options, positionals)

  const rawResumeId =
    typeof options["resume-id"] === "string" ? options["resume-id"] : null
  if (rawResumeId && rawResumeId.startsWith("-")) {
    throw new Error(
      `Invalid --resume-id value: "${rawResumeId}". Provide a thread ID, not a flag.`,
    )
  }
  const resumeId = rawResumeId
  const resumeLast = Boolean(options["resume-last"] || options.resume)
  const fresh = Boolean(options.fresh)
  if ((resumeLast || resumeId) && fresh) {
    throw new Error(
      "Choose either --resume/--resume-last/--resume-id or --fresh.",
    )
  }
  const write = Boolean(options.write)
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(resumeId),
  })

  if (options.background) {
    ensureCodexAvailable(cwd)
    requireTaskRequest(prompt, resumeLast || Boolean(resumeId))

    const job = buildTaskJob(workspaceRoot, taskMetadata, write)
    const request = buildTaskRequest({
      cwd,
      effort,
      jobId: job.id as string,
      model,
      prompt,
      resumeId,
      resumeLast,
      write,
    })
    const { payload } = enqueueBackgroundTask(cwd, job, request)
    outputCommandResult(
      payload,
      renderQueuedTaskLaunch(payload),
      Boolean(options.json),
    )
    return
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write)
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        effort,
        jobId: job.id as string,
        model,
        onProgress: progress,
        prompt,
        resumeId,
        resumeLast,
        write,
      }),
    { json: Boolean(options.json) },
  )
}

async function handleTaskWorker(argv: string[]): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"],
  })

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.")
  }

  const workspaceRoot = resolveCommandWorkspace(options)
  const storedJob = readStoredJob(workspaceRoot, options["job-id"] as string)
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`)
  }

  const request = storedJob.request as Record<string, any> | undefined
  if (!request || typeof request !== "object") {
    throw new Error(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
    )
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: (storedJob.logFile as null | string) ?? null },
  )
  await runTrackedJob(
    { ...storedJob, id: storedJob.id as string, logFile, workspaceRoot },
    () =>
      executeTaskRun({
        ...(request as TaskRunRequest),
        onProgress: progress,
      }),
    { logFile },
  )
}

async function handleStatus(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json", "all", "wait"],
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ""
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          pollIntervalMs: options["poll-interval-ms"] as
            | number
            | string
            | undefined,
          timeoutMs: options["timeout-ms"] as number | string | undefined,
        })
      : buildSingleJobSnapshot(cwd, reference)
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job),
      Boolean(options.json),
    )
    return
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.")
  }

  const report = buildStatusSnapshot(cwd, { all: Boolean(options.all) })
  outputResult(
    renderStatusPayload(report, Boolean(options.json)),
    Boolean(options.json),
  )
}

function handleResult(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ""
  const { job, workspaceRoot } = resolveResultJob(cwd, reference)
  const storedJob = readStoredJob(workspaceRoot, job.id)
  const payload = { job, storedJob }

  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob),
    Boolean(options.json),
  )
}

function handleTaskResumeCandidate(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })

  const workspaceRoot = resolveCommandWorkspace(options)
  const sessionId = getCurrentClaudeSessionId()
  const jobs = filterJobsForCurrentClaudeSession(
    sortJobsNewestFirst(listJobs(workspaceRoot)),
  )
  const candidate = findLatestResumableTaskJob(jobs)

  const payload = {
    available: Boolean(candidate),
    candidate:
      candidate == null
        ? null
        : {
            completedAt: candidate.completedAt ?? null,
            id: candidate.id,
            status: candidate.status,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            title: candidate.title ?? null,
            updatedAt: candidate.updatedAt ?? null,
          },
    sessionId,
  }

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${coerceString(candidate.status)}).\n`
    : "No resumable task found for this session.\n"
  outputCommandResult(payload, rendered, Boolean(options.json))
}

async function handleCancel(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ""
  const { job, workspaceRoot } = resolveCancelableJob(cwd, reference, {
    env: process.env,
  })
  const existing = readStoredJob(workspaceRoot, job.id) ?? {}
  const threadId =
    (existing.threadId as null | string | undefined) ??
    (job.threadId as null | string | undefined) ??
    null
  const turnId =
    (existing.turnId as null | string | undefined) ??
    (job.turnId as null | string | undefined) ??
    null

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId })
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile as null | string,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`,
    )
  }

  terminateProcessTree(Number(job.pid) || Number.NaN)
  appendLogLine(job.logFile as null | string, "Cancelled by user.")

  const completedAt = nowIso()
  const nextJob: Record<string, any> = {
    ...job,
    completedAt,
    errorMessage: "Cancelled by user.",
    phase: "cancelled",
    pid: null,
    status: "cancelled",
  }

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
  })
  upsertJob(workspaceRoot, {
    completedAt,
    errorMessage: "Cancelled by user.",
    id: job.id,
    phase: "cancelled",
    pid: null,
    status: "cancelled",
  })

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
  }

  outputCommandResult(
    payload,
    renderCancelReport(nextJob),
    Boolean(options.json),
  )
}

async function main(): Promise<void> {
  const [subcommand, ...argv] = process.argv.slice(2)
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage()
    return
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv)
      break
    case "review":
      await handleReview(argv)
      break
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" })
      break
    case "task":
      await handleTask(argv)
      break
    case "task-worker":
      await handleTaskWorker(argv)
      break
    case "status":
      await handleStatus(argv)
      break
    case "result":
      handleResult(argv)
      break
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv)
      break
    case "cancel":
      await handleCancel(argv)
      break
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
