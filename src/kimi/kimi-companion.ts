import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { parseArgs, splitRawArgumentString } from "./lib/args.js"
import { readStdinIfPiped } from "./lib/fs.js"
import { collectReviewContext, resolveReviewTarget } from "./lib/git.js"
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
} from "./lib/job-control.js"
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getKimiAuthStatus,
  getKimiAvailability,
  getSessionRuntimeStatus,
  interruptKimiTurn,
  runKimiReview,
  runKimiTurn,
} from "./lib/kimi.js"
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
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile,
} from "./lib/state.js"
import { coerceString } from "./lib/strings.js"
import { parseStructuredOutput } from "./lib/structured-output.js"
import {
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV,
} from "./lib/tracked-jobs.js"
import { resolveWorkspaceRoot } from "./lib/workspace.js"

const ROOT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)))

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  node dist/kimi-companion.js setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node dist/kimi-companion.js review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node dist/kimi-companion.js adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node dist/kimi-companion.js task [--background] [--write] [--resume-last|--resume <session-id>|--fresh] [--model <model>] [prompt]",
      "  node dist/kimi-companion.js task-resume-candidate [--json]",
      "  node dist/kimi-companion.js status [job-id] [--all] [--json]",
      "  node dist/kimi-companion.js result [job-id] [--json]",
      "  node dist/kimi-companion.js cancel [job-id] [--json]",
    ].join("\n"),
  )
}

function outputResult(value: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2))
  } else {
    process.stdout.write(typeof value === "string" ? value : String(value))
  }
}

function outputCommandResult(
  payload: unknown,
  rendered: string,
  asJson: boolean,
): void {
  outputResult(asJson ? payload : rendered, asJson)
}

function normalizeRequestedModel(model: unknown): null | string {
  if (model == null) {
    return null
  }
  const normalized = coerceString(model).trim()
  if (!normalized) {
    return null
  }
  return normalized
}

function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 1) {
    const [raw] = argv
    if (!raw || !raw.trim()) {
      return []
    }
    return splitRawArgumentString(raw)
  }
  return argv
}

function parseCommandInput(
  argv: string[],
  config: Record<string, unknown> = {},
): {
  options: Record<string, boolean | string>
  positionals: string[]
} {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap as Record<string, string> | undefined),
    },
  })
}

function resolveCommandCwd(options: Record<string, any> = {}): string {
  return options.cwd
    ? path.resolve(process.cwd(), String(options.cwd))
    : process.cwd()
}

function resolveCommandWorkspace(options: Record<string, any> = {}): string {
  return resolveWorkspaceRoot(resolveCommandCwd(options))
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

function ensureKimiAvailable(cwd: string): void {
  const availability = getKimiAvailability(cwd)
  if (!availability.available) {
    throw new Error(
      `Kimi CLI is not installed. ${availability.detail} Run /kimi:setup for guidance.`,
    )
  }
  const auth = getKimiAuthStatus(cwd)
  if (!auth.authenticated) {
    throw new Error(
      `Kimi is not authenticated. ${auth.detail} Run /kimi:setup for guidance.`,
    )
  }
}

function buildSetupReport(
  cwd: string,
  actionsTaken: string[],
): Record<string, unknown> {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd })
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd })
  const kimiStatus = getKimiAvailability(cwd)
  const authStatus = getKimiAuthStatus(cwd)
  const config = getConfig(workspaceRoot)

  const nextSteps: string[] = []
  if (!kimiStatus.available) {
    nextSteps.push(
      "Install Kimi CLI: `pip install kimi-cli` or `uv tool install kimi-cli`.",
    )
  }
  if (kimiStatus.available && !authStatus.authenticated) {
    nextSteps.push(
      "Export `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) in your shell environment.",
    )
  }
  if (!config.stopReviewGate) {
    nextSteps.push(
      "Optional: run `/kimi:setup --enable-review-gate` to require a fresh review before stop.",
    )
  }

  return {
    actionsTaken,
    auth: { detail: authStatus.detail, loggedIn: authStatus.authenticated },
    kimi: { available: kimiStatus.available, detail: kimiStatus.detail },
    nextSteps,
    node: nodeStatus,
    npm: npmStatus,
    ready:
      nodeStatus.available && kimiStatus.available && authStatus.authenticated,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
  }
}

function handleSetup(argv: string[]): void {
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

  const report = buildSetupReport(cwd, actionsTaken)
  outputResult(
    options.json ? report : renderSetupReport(report),
    Boolean(options.json),
  )
}

function buildAdversarialReviewPrompt(
  context: {
    collectionGuidance: string
    content: string
    target: { label: string }
  },
  focusText: string,
): string {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review")
  return interpolateTemplate(template, {
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
  })
}

interface ReviewRequest {
  base?: string
  cwd: string
  focusText: string
  model: null | string
  reviewName: string
  scope?: string
}

async function executeReviewRun(
  request: ReviewRequest,
  progress: ((event: unknown) => void) | null,
): Promise<{
  exitStatus: number
  payload: Record<string, unknown>
  rendered: string
  summary: string
  threadId: null | string
}> {
  ensureKimiAvailable(request.cwd)
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope as never,
  })
  const context = collectReviewContext(request.cwd, target)

  let prompt: string
  if (request.reviewName === "Adversarial Review") {
    prompt = buildAdversarialReviewPrompt(
      {
        collectionGuidance: context.collectionGuidance,
        content: context.content,
        target,
      },
      request.focusText,
    )
  } else {
    prompt =
      `Review the following changes in detail. Return a JSON object with fields {verdict, summary, findings:[], next_steps:[]} as instructed.\n\n` +
      `Target: ${target.label}\n\n${context.content}`
  }

  const reviewResult = await runKimiReview({
    cwd: request.cwd,
    model: request.model,
    onProgress: progress as never,
    prompt,
  })

  const meta = {
    reasoningSummary: reviewResult.reasoningSummary,
    reviewLabel: request.reviewName,
    targetLabel: target.label,
  }

  const parsedResult = parseStructuredOutput(reviewResult.reviewText, {
    failureMessage: reviewResult.error?.message ?? null,
    reasoningSummary: reviewResult.reasoningSummary,
  })

  const isStructured = parsedResult.parsed && !parsedResult.parseError
  const rendered = isStructured
    ? renderReviewResult(parsedResult as never, meta)
    : renderNativeReviewResult(
        {
          status: reviewResult.status,
          stderr: reviewResult.stderr,
          stdout: reviewResult.reviewText,
        },
        meta,
      )

  const summary = isStructured
    ? shorten(
        (parsedResult.parsed?.summary as string | undefined) ??
          request.reviewName,
      )
    : shorten(
        reviewResult.reviewText.split(/\r?\n/, 1)[0] ?? request.reviewName,
      )

  return {
    exitStatus: reviewResult.status,
    payload: {
      kimi: { stderr: reviewResult.stderr, stdout: reviewResult.reviewText },
      parsed: parsedResult,
      target,
    },
    rendered,
    summary,
    threadId: reviewResult.threadId,
  }
}

async function handleReviewCommand(
  argv: string[],
  reviewName: string,
): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    aliasMap: { m: "model" },
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["base", "scope", "model", "cwd"],
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const focusText = positionals.join(" ").trim()
  const model = normalizeRequestedModel(options.model)

  const jobId = generateJobId("review")
  const title = `${reviewName}${focusText ? `: ${shorten(focusText, 60)}` : ""}`
  const logFile = createJobLogFile(workspaceRoot, jobId, title)
  const progress = createProgressReporter({ logFile })
  const updateProgress = createJobProgressUpdater(workspaceRoot, jobId)
  const combinedProgress = (event: unknown): void => {
    progress?.(event)
    updateProgress(event)
  }

  const baseJob = createJobRecord({
    id: jobId,
    jobClass: "review",
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    logFile,
    summary: title,
    title,
    workspaceRoot,
  })

  await runTrackedJob(
    { ...baseJob, id: jobId, logFile, workspaceRoot },
    async () => {
      const review = await executeReviewRun(
        {
          base: options.base as string | undefined,
          cwd,
          focusText,
          model,
          reviewName,
          scope: options.scope as string | undefined,
        },
        combinedProgress,
      )
      outputCommandResult(
        {
          jobId,
          payload: review.payload,
          status: review.exitStatus === 0 ? "completed" : "failed",
        },
        review.rendered,
        Boolean(options.json),
      )
      return {
        exitStatus: review.exitStatus,
        payload: review.payload,
        rendered: review.rendered,
        summary: review.summary,
        threadId: review.threadId,
      }
    },
    { logFile },
  )
}

async function handleReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, "Review")
}

async function handleAdversarialReview(argv: string[]): Promise<void> {
  return handleReviewCommand(argv, "Adversarial Review")
}

interface TaskExecutionRequest {
  cwd: string
  model: null | string
  prompt: string
  resumeId: null | string
  write: boolean
}

async function executeTaskRun(
  request: TaskExecutionRequest,
  progress: ((event: unknown) => void) | null,
): Promise<{
  exitStatus: number
  payload: Record<string, unknown>
  rendered: string
  summary: string
  threadId: null | string
  turnId: null | string
}> {
  ensureKimiAvailable(request.cwd)
  const turn = await runKimiTurn(
    {
      cwd: request.cwd,
      model: request.model,
      prompt: request.prompt,
      resumeId: request.resumeId,
      write: request.write,
    },
    progress,
  )
  const parsedResult = {
    failureMessage: turn.failureMessage,
    rawOutput: turn.rawOutput,
    reasoningSummary: turn.reasoningSummary,
  }
  const rendered = renderTaskResult(parsedResult, {
    reasoningSummary: turn.reasoningSummary,
  })
  const summary = shorten(
    turn.rawOutput.trim() || turn.failureMessage || "Kimi task complete.",
  )
  return {
    exitStatus: turn.exitStatus,
    payload: {
      kimi: { rawOutput: turn.rawOutput },
      rawOutput: turn.rawOutput,
      reasoningSummary: turn.reasoningSummary,
    },
    rendered,
    summary,
    threadId: turn.threadId,
    turnId: turn.turnId,
  }
}

function readTaskPrompt(
  _cwd: string,
  options: Record<string, any>,
  positionals: string[],
): string {
  const direct = positionals.join(" ").trim()
  if (direct) {
    return direct
  }
  if (typeof options["prompt-file"] === "string") {
    const filePath = String(options["prompt-file"])
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs") as typeof import("node:fs")
      const data = fs.readFileSync(filePath, "utf8").trim()
      if (data) {
        return data
      }
    } catch {
      /* fall through */
    }
  }
  const piped = readStdinIfPiped()
  if (piped && piped.trim()) {
    return piped.trim()
  }
  return ""
}

function resolveResumeThreadId(workspaceRoot: string): null | string {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot))
  const thread = findLatestTaskThread(jobs as never)
  return thread?.threadId ?? null
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
    valueOptions: ["model", "cwd", "prompt-file", "resume-id"],
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const model = normalizeRequestedModel(options.model)
  const rawPrompt = readTaskPrompt(cwd, options, positionals)

  const explicitResumeId =
    typeof options["resume-id"] === "string"
      ? String(options["resume-id"])
      : null
  if (explicitResumeId?.startsWith("-")) {
    throw new Error(
      `Invalid --resume-id value: "${explicitResumeId}". Provide a session id, not a flag.`,
    )
  }
  const resumeLast = Boolean(options["resume-last"] || options.resume)
  const fresh = Boolean(options.fresh)
  if ((resumeLast || explicitResumeId) && fresh) {
    throw new Error(
      "Choose either --resume/--resume-last/--resume-id or --fresh.",
    )
  }
  const write = Boolean(options.write)

  const resolvedResumeId = explicitResumeId
    ? explicitResumeId
    : resumeLast
      ? resolveResumeThreadId(workspaceRoot)
      : null

  const prompt = rawPrompt || (resolvedResumeId ? DEFAULT_CONTINUE_PROMPT : "")
  if (!prompt) {
    throw new Error("Task prompt is required. Pass it as the positional arg.")
  }

  const title = buildPersistentTaskThreadName(prompt)
  const jobId = generateJobId("task")
  const baseJob = createJobRecord({
    id: jobId,
    jobClass: "task",
    kind: "task",
    summary: shorten(prompt, 72),
    title,
    workspaceRoot,
    write,
  })

  if (options.background) {
    const logFile = createJobLogFile(workspaceRoot, jobId, title)
    const queuedRecord = {
      ...baseJob,
      logFile,
      phase: "queued",
      request: {
        cwd,
        model,
        prompt,
        resumeId: resolvedResumeId,
        write,
      },
      status: "queued",
    }
    writeJobFile(workspaceRoot, jobId, queuedRecord)
    upsertJob(workspaceRoot, { id: jobId, ...queuedRecord })

    const workerArgs = [
      path.join(ROOT_DIR, "kimi-companion.js"),
      "task-worker",
      "--job-id",
      jobId,
      "--cwd",
      workspaceRoot,
    ]
    const child = spawn(process.execPath, workerArgs, {
      cwd: workspaceRoot,
      detached: true,
      env: process.env,
      stdio: "ignore",
    })
    child.unref()

    outputCommandResult(
      { background: true, jobId, status: "queued" },
      `Kimi task queued as ${jobId}. Check /kimi:status ${jobId}.\n`,
      Boolean(options.json),
    )
    return
  }

  const logFile = createJobLogFile(workspaceRoot, jobId, title)
  const progress = createProgressReporter({ logFile })
  const updateProgress = createJobProgressUpdater(workspaceRoot, jobId)
  const combinedProgress = (event: unknown): void => {
    progress?.(event)
    updateProgress(event)
  }

  const execution = await runTrackedJob(
    { ...baseJob, id: jobId, logFile, workspaceRoot },
    async () => {
      const result = await executeTaskRun(
        { cwd, model, prompt, resumeId: resolvedResumeId, write },
        combinedProgress,
      )
      return {
        exitStatus: result.exitStatus,
        payload: result.payload,
        rendered: result.rendered,
        summary: result.summary,
        threadId: result.threadId,
        turnId: result.turnId,
      }
    },
    { logFile },
  )

  outputCommandResult(
    {
      jobId,
      payload: execution.payload,
      status: execution.exitStatus === 0 ? "completed" : "failed",
    },
    execution.rendered,
    Boolean(options.json),
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
  const stored = readStoredJob(workspaceRoot, String(options["job-id"]))
  if (!stored) {
    throw new Error(`No stored job found for ${options["job-id"]}.`)
  }
  const request = (stored as any).request as TaskExecutionRequest | undefined
  if (!request) {
    throw new Error(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
    )
  }
  const logFile = (stored as any).logFile as null | string
  const progress = createProgressReporter({ logFile })
  const updateProgress = createJobProgressUpdater(
    workspaceRoot,
    String(options["job-id"]),
  )
  const combinedProgress = (event: unknown): void => {
    progress?.(event)
    updateProgress(event)
  }
  await runTrackedJob(
    { ...stored, logFile, workspaceRoot } as never,
    async () => {
      const result = await executeTaskRun(request, combinedProgress)
      return {
        exitStatus: result.exitStatus,
        payload: result.payload,
        rendered: result.rendered,
        summary: result.summary,
        threadId: result.threadId,
        turnId: result.turnId,
      }
    },
    { logFile },
  )
}

function handleTaskResumeCandidate(argv: string[]): void {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })
  const workspaceRoot = resolveCommandWorkspace(options)
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot))
  const thread = findLatestTaskThread(jobs as never)
  const payload = thread
    ? {
        available: true,
        jobId: thread.jobId,
        name: thread.name,
        threadId: thread.threadId,
        updatedAt: thread.updatedAt,
      }
    : { available: false }
  outputResult(payload, Boolean(options.json))
}

function handleStatus(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["all", "json"],
    valueOptions: ["cwd"],
  })
  const reference = positionals[0]
  const cwd = resolveCommandCwd(options)

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference)
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job),
      Boolean(options.json),
    )
    return
  }

  const snapshot = buildStatusSnapshot(cwd, {
    all: Boolean(options.all),
    env: process.env,
  })
  outputCommandResult(
    snapshot,
    renderStatusReport(snapshot),
    Boolean(options.json),
  )
}

function handleResult(argv: string[]): void {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })
  const cwd = resolveCommandCwd(options)
  const reference = positionals[0]
  const snapshot = resolveResultJob(cwd, reference)
  const stored = readStoredJob(snapshot.workspaceRoot, snapshot.job.id)
  outputCommandResult(
    { job: snapshot.job, stored },
    renderStoredJobResult(snapshot.job, stored),
    Boolean(options.json),
  )
}

async function handleCancel(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  })
  const cwd = resolveCommandCwd(options)
  const reference = positionals[0]
  const snapshot = resolveCancelableJob(cwd, reference, { env: process.env })

  const interrupt = await interruptKimiTurn(snapshot.workspaceRoot, {
    env: process.env,
  })

  const pid =
    typeof snapshot.job.pid === "number" && Number.isFinite(snapshot.job.pid)
      ? snapshot.job.pid
      : null
  if (pid) {
    try {
      terminateProcessTree(pid)
    } catch {
      /* Best-effort termination. */
    }
  }

  const completedAt = nowIso()
  const nextJob = {
    ...snapshot.job,
    completedAt,
    errorMessage: "Cancelled by user.",
    phase: "cancelled",
    pid: null,
    status: "cancelled",
  }
  writeJobFile(snapshot.workspaceRoot, snapshot.job.id, nextJob)
  upsertJob(snapshot.workspaceRoot, {
    completedAt,
    errorMessage: "Cancelled by user.",
    id: snapshot.job.id,
    phase: "cancelled",
    pid: null,
    status: "cancelled",
  })

  outputCommandResult(
    {
      jobId: snapshot.job.id,
      status: "cancelled",
      turnInterruptAttempted: true,
      turnInterrupted: interrupt.delivered,
    },
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
    case "setup": {
      handleSetup(argv)
      break
    }
    case "review": {
      await handleReview(argv)
      break
    }
    case "adversarial-review": {
      await handleAdversarialReview(argv)
      break
    }
    case "task": {
      await handleTask(argv)
      break
    }
    case "task-worker": {
      await handleTaskWorker(argv)
      break
    }
    case "task-resume-candidate": {
      handleTaskResumeCandidate(argv)
      break
    }
    case "status": {
      handleStatus(argv)
      break
    }
    case "result": {
      handleResult(argv)
      break
    }
    case "cancel": {
      await handleCancel(argv)
      break
    }
    default: {
      throw new Error(`Unknown subcommand: ${subcommand}`)
    }
  }
}

void SESSION_ID_ENV

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
