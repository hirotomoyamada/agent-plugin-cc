import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.js";

export const SESSION_ID_ENV = "AGENT_COMPANION_SESSION_ID";

interface NormalizedProgressEvent {
  message: string;
  phase: string | null;
  threadId: string | null;
  turnId: string | null;
  stderrMessage: string | null;
  logTitle: string | null;
  logBody: string | null;
}

export interface JobExecution {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  payload: unknown;
  rendered: string;
  summary: string;
}

export interface TrackedJob {
  id: string;
  workspaceRoot: string;
  logFile?: string | null;
  [key: string]: unknown;
}

export type ProgressReporter = ((eventOrMessage: unknown) => void) | null;

export function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProgressEvent(value: unknown): NormalizedProgressEvent {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return {
      message: String(obj.message ?? "").trim(),
      phase: typeof obj.phase === "string" && obj.phase.trim() ? obj.phase.trim() : null,
      threadId: typeof obj.threadId === "string" && obj.threadId.trim() ? obj.threadId.trim() : null,
      turnId: typeof obj.turnId === "string" && obj.turnId.trim() ? obj.turnId.trim() : null,
      stderrMessage: obj.stderrMessage == null ? null : String(obj.stderrMessage).trim(),
      logTitle: typeof obj.logTitle === "string" && obj.logTitle.trim() ? obj.logTitle.trim() : null,
      logBody: obj.logBody == null ? null : String(obj.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile: string | null, message: unknown): void {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile: string | null, title: string | null, body: unknown): void {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot: string, jobId: string, title?: string): string {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

interface CreateJobRecordOptions {
  env?: Record<string, string | undefined>;
  sessionIdEnv?: string;
}

export function createJobRecord(
  base: Record<string, unknown>,
  options: CreateJobRecordOptions = {}
): Record<string, unknown> {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot: string, jobId: string): (event: unknown) => void {
  let lastPhase: string | null = null;
  let lastThreadId: string | null = null;
  let lastTurnId: string | null = null;

  return (event: unknown): void => {
    const normalized = normalizeProgressEvent(event);
    const patch: Record<string, unknown> = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, { id: jobId, ...patch });

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, { ...storedJob, ...patch });
  };
}

interface ProgressReporterOptions {
  stderr?: boolean;
  logFile?: string | null;
  onEvent?: ((event: NormalizedProgressEvent) => void) | null;
}

export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter {
  const { stderr = false, logFile = null, onEvent = null } = options;
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage: unknown): void => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[agent] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot: string, jobId: string): Record<string, unknown> | null {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

interface RunTrackedJobOptions {
  logFile?: string | null;
}

export async function runTrackedJob(
  job: TrackedJob,
  runner: () => Promise<JobExecution>,
  options: RunTrackedJobOptions = {}
): Promise<JobExecution> {
  const runningRecord: Record<string, unknown> = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, { id: job.id, ...runningRecord });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? (existing.logFile as string | null) ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
