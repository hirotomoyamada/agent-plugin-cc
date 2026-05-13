import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coerceString } from "./strings.js";
import { resolveWorkspaceRoot } from "./workspace.js";
const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
function nowIso() {
    return new Date().toISOString();
}
function defaultState() {
    return {
        config: {
            stopReviewGate: false,
        },
        jobs: [],
        version: STATE_VERSION,
    };
}
export function resolveStateDir(config, cwd) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    let canonicalWorkspaceRoot = workspaceRoot;
    try {
        canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    }
    catch {
        canonicalWorkspaceRoot = workspaceRoot;
    }
    const slugSource = path.basename(workspaceRoot) || "workspace";
    const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
        "workspace";
    const hash = createHash("sha256")
        .update(canonicalWorkspaceRoot)
        .digest("hex")
        .slice(0, 16);
    const pluginDataDir = process.env[PLUGIN_DATA_ENV];
    const stateRoot = pluginDataDir
        ? path.join(pluginDataDir, "state")
        : path.join(os.tmpdir(), config.paths.stateRootDirName);
    return path.join(stateRoot, `${slug}-${hash}`);
}
export function resolveStateFile(config, cwd) {
    return path.join(resolveStateDir(config, cwd), STATE_FILE_NAME);
}
export function resolveJobsDir(config, cwd) {
    return path.join(resolveStateDir(config, cwd), JOBS_DIR_NAME);
}
export function ensureStateDir(config, cwd) {
    fs.mkdirSync(resolveJobsDir(config, cwd), { recursive: true });
}
export function loadState(config, cwd) {
    const stateFile = resolveStateFile(config, cwd);
    if (!fs.existsSync(stateFile)) {
        return defaultState();
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        return {
            ...defaultState(),
            ...parsed,
            config: {
                ...defaultState().config,
                ...parsed.config,
            },
            jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        };
    }
    catch {
        return defaultState();
    }
}
function pruneJobs(jobs) {
    return [...jobs]
        .sort((left, right) => coerceString(right.updatedAt).localeCompare(coerceString(left.updatedAt)))
        .slice(0, MAX_JOBS);
}
function removeFileIfExists(filePath) {
    if (filePath && typeof filePath === "string" && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}
export function saveState(config, cwd, state) {
    const previousJobs = loadState(config, cwd).jobs;
    ensureStateDir(config, cwd);
    const nextJobs = pruneJobs(state.jobs ?? []);
    const nextState = {
        config: {
            ...defaultState().config,
            ...state.config,
        },
        jobs: nextJobs,
        version: STATE_VERSION,
    };
    const retainedIds = new Set(nextJobs.map((job) => job.id));
    for (const job of previousJobs) {
        if (retainedIds.has(job.id)) {
            continue;
        }
        removeJobFile(resolveJobFile(config, cwd, job.id));
        removeFileIfExists(job.logFile);
    }
    fs.writeFileSync(resolveStateFile(config, cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    return nextState;
}
export function updateState(config, cwd, mutate) {
    const state = loadState(config, cwd);
    mutate(state);
    return saveState(config, cwd, state);
}
export function generateJobId(prefix = "job") {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
}
export function upsertJob(config, cwd, jobPatch) {
    return updateState(config, cwd, (state) => {
        const timestamp = nowIso();
        const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
        if (existingIndex === -1) {
            state.jobs.unshift({
                createdAt: timestamp,
                updatedAt: timestamp,
                ...jobPatch,
            });
            return;
        }
        state.jobs[existingIndex] = {
            ...state.jobs[existingIndex],
            ...jobPatch,
            updatedAt: timestamp,
        };
    });
}
export function listJobs(config, cwd) {
    return loadState(config, cwd).jobs;
}
export function setConfig(config, cwd, key, value) {
    return updateState(config, cwd, (state) => {
        state.config = { ...state.config, [key]: value };
    });
}
export function getConfig(config, cwd) {
    return loadState(config, cwd).config;
}
export function writeJobFile(config, cwd, jobId, payload) {
    ensureStateDir(config, cwd);
    const jobFile = resolveJobFile(config, cwd, jobId);
    fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return jobFile;
}
export function readJobFile(jobFile) {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}
function removeJobFile(jobFile) {
    if (fs.existsSync(jobFile)) {
        fs.unlinkSync(jobFile);
    }
}
export function resolveJobLogFile(config, cwd, jobId) {
    ensureStateDir(config, cwd);
    return path.join(resolveJobsDir(config, cwd), `${jobId}.log`);
}
export function resolveJobFile(config, cwd, jobId) {
    ensureStateDir(config, cwd);
    return path.join(resolveJobsDir(config, cwd), `${jobId}.json`);
}
