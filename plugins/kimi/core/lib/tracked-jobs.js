import fs from "node:fs";
import process from "node:process";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile, } from "./state.js";
import { coerceString } from "./strings.js";
export function nowIso() {
    return new Date().toISOString();
}
function normalizeProgressEvent(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value;
        return {
            logBody: obj.logBody == null ? null : coerceString(obj.logBody).trimEnd(),
            logTitle: typeof obj.logTitle === "string" && obj.logTitle.trim()
                ? obj.logTitle.trim()
                : null,
            message: coerceString(obj.message).trim(),
            phase: typeof obj.phase === "string" && obj.phase.trim()
                ? obj.phase.trim()
                : null,
            stderrMessage: obj.stderrMessage == null
                ? null
                : coerceString(obj.stderrMessage).trim(),
            threadId: typeof obj.threadId === "string" && obj.threadId.trim()
                ? obj.threadId.trim()
                : null,
            turnId: typeof obj.turnId === "string" && obj.turnId.trim()
                ? obj.turnId.trim()
                : null,
        };
    }
    const text = coerceString(value).trim();
    return {
        logBody: null,
        logTitle: null,
        message: text,
        phase: null,
        stderrMessage: text,
        threadId: null,
        turnId: null,
    };
}
export function appendLogLine(logFile, message) {
    const normalized = coerceString(message).trim();
    if (!logFile || !normalized) {
        return;
    }
    fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}
export function appendLogBlock(logFile, title, body) {
    if (!logFile || !body) {
        return;
    }
    fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${coerceString(body).trimEnd()}\n`, "utf8");
}
export function createJobLogFile(config, workspaceRoot, jobId, title) {
    const logFile = resolveJobLogFile(config, workspaceRoot, jobId);
    fs.writeFileSync(logFile, "", "utf8");
    if (title) {
        appendLogLine(logFile, `Starting ${title}.`);
    }
    return logFile;
}
export function createJobRecord(config, base, options = {}) {
    const env = options.env ?? process.env;
    const sessionId = env[config.envVars.sessionId];
    return {
        ...base,
        createdAt: nowIso(),
        ...(sessionId ? { sessionId } : {}),
    };
}
export function createJobProgressUpdater(config, workspaceRoot, jobId) {
    let lastPhase = null;
    let lastThreadId = null;
    let lastTurnId = null;
    return (event) => {
        const normalized = normalizeProgressEvent(event);
        const patch = { id: jobId };
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
        upsertJob(config, workspaceRoot, { id: jobId, ...patch });
        const jobFile = resolveJobFile(config, workspaceRoot, jobId);
        if (!fs.existsSync(jobFile)) {
            return;
        }
        const storedJob = readJobFile(jobFile);
        writeJobFile(config, workspaceRoot, jobId, { ...storedJob, ...patch });
    };
}
export function createProgressReporter(config, options = {}) {
    const { logFile = null, onEvent = null, stderr = false } = options;
    if (!stderr && !logFile && !onEvent) {
        return null;
    }
    return (eventOrMessage) => {
        const event = normalizeProgressEvent(eventOrMessage);
        const stderrMessage = event.stderrMessage ?? event.message;
        if (stderr && stderrMessage) {
            process.stderr.write(`[${config.log.stderrLabel}] ${stderrMessage}\n`);
        }
        appendLogLine(logFile, event.message);
        appendLogBlock(logFile, event.logTitle, event.logBody);
        onEvent?.(event);
    };
}
function readStoredJobOrNull(config, workspaceRoot, jobId) {
    const jobFile = resolveJobFile(config, workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
        return null;
    }
    return readJobFile(jobFile);
}
export async function runTrackedJob(config, job, runner, options = {}) {
    const runningRecord = {
        ...job,
        logFile: options.logFile ?? job.logFile ?? null,
        phase: "starting",
        pid: process.pid,
        startedAt: nowIso(),
        status: "running",
    };
    writeJobFile(config, job.workspaceRoot, job.id, runningRecord);
    upsertJob(config, job.workspaceRoot, { id: job.id, ...runningRecord });
    try {
        const execution = await runner();
        const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
        const completedAt = nowIso();
        writeJobFile(config, job.workspaceRoot, job.id, {
            ...runningRecord,
            completedAt,
            phase: completionStatus === "completed" ? "done" : "failed",
            pid: null,
            rendered: execution.rendered,
            result: execution.payload,
            status: completionStatus,
            threadId: execution.threadId ?? null,
            turnId: execution.turnId ?? null,
        });
        upsertJob(config, job.workspaceRoot, {
            completedAt,
            id: job.id,
            phase: completionStatus === "completed" ? "done" : "failed",
            pid: null,
            status: completionStatus,
            summary: execution.summary,
            threadId: execution.threadId ?? null,
            turnId: execution.turnId ?? null,
        });
        appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
        return execution;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const existing = readStoredJobOrNull(config, job.workspaceRoot, job.id) ?? runningRecord;
        const completedAt = nowIso();
        writeJobFile(config, job.workspaceRoot, job.id, {
            ...existing,
            completedAt,
            errorMessage,
            logFile: options.logFile ??
                job.logFile ??
                existing.logFile ??
                null,
            phase: "failed",
            pid: null,
            status: "failed",
        });
        upsertJob(config, job.workspaceRoot, {
            completedAt,
            errorMessage,
            id: job.id,
            phase: "failed",
            pid: null,
            status: "failed",
        });
        throw error;
    }
}
