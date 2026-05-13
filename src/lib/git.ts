import fs from "node:fs"
import path from "node:path"

import { isProbablyText } from "./fs.js"
import {
  type CommandResult,
  formatCommandFailure,
  runCommand,
  runCommandChecked,
  type RunCommandOptions,
} from "./process.js"

const MAX_UNTRACKED_BYTES = 24 * 1024
const DEFAULT_INLINE_DIFF_MAX_FILES = 2
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024

export interface WorkingTreeState {
  isDirty: boolean
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export type ReviewTarget =
  | { baseRef: string; explicit: boolean; label: string; mode: "branch" }
  | { explicit: boolean; label: string; mode: "working-tree" }

interface BranchComparison {
  commitRange: string
  mergeBase: string
  reviewRange: string
}

interface ReviewTargetOptions {
  base?: null | string
  scope?: string
}

interface CollectContextOptions {
  includeDiff?: boolean
  maxInlineDiffBytes?: number
  maxInlineFiles?: number
}

export interface ReviewContext {
  branch: string
  changedFiles: string[]
  collectionGuidance: string
  content: string
  cwd: string
  diffBytes: number
  fileCount: number
  inputMode: string
  mode: string
  repoRoot: string
  summary: string
  target: ReviewTarget
}

function git(
  cwd: string,
  args: string[],
  options: RunCommandOptions = {},
): CommandResult {
  return runCommand("git", args, { cwd, ...options })
}

function gitChecked(
  cwd: string,
  args: string[],
  options: RunCommandOptions = {},
): CommandResult {
  return runCommandChecked("git", args, { cwd, ...options })
}

function listUniqueFiles(...groups: (string | undefined)[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean) as string[])].sort()
}

function normalizeMaxInlineFiles(value: number | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES
  }
  return Math.floor(parsed)
}

function normalizeMaxInlineDiffBytes(value: number | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES
  }
  return Math.floor(parsed)
}

function measureGitOutputBytes(
  cwd: string,
  args: string[],
  maxBytes: number,
): number {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 })
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === "ENOBUFS"
  ) {
    return maxBytes + 1
  }
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result))
  }
  return Buffer.byteLength(result.stdout, "utf8")
}

function measureCombinedGitOutputBytes(
  cwd: string,
  argSets: string[][],
  maxBytes: number,
): number {
  let totalBytes = 0
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes
    if (remainingBytes < 0) {
      return maxBytes + 1
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes)
    if (totalBytes > maxBytes) {
      return totalBytes
    }
  }
  return totalBytes
}

function buildBranchComparison(cwd: string, baseRef: string): BranchComparison {
  const mergeBase = gitChecked(cwd, [
    "merge-base",
    "HEAD",
    baseRef,
  ]).stdout.trim()
  return {
    commitRange: `${mergeBase}..HEAD`,
    mergeBase,
    reviewRange: `${baseRef}...HEAD`,
  }
}

export function ensureGitRepository(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--show-toplevel"])
  const errorCode =
    result.error && "code" in result.error
      ? (result.error as NodeJS.ErrnoException).code
      : null
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.")
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.")
  }
  return result.stdout.trim()
}

export function getRepoRoot(cwd: string): string {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim()
}

export function detectDefaultBranch(cwd: string): string {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim()
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "")
    }
  }
  const candidates = ["main", "master", "trunk"]
  for (const candidate of candidates) {
    const local = git(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${candidate}`,
    ])
    if (local.status === 0) {
      return candidate
    }
    const remote = git(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${candidate}`,
    ])
    if (remote.status === 0) {
      return `origin/${candidate}`
    }
  }
  throw new Error(
    "Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.",
  )
}

export function getCurrentBranch(cwd: string): string {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD"
}

export function getWorkingTreeState(cwd: string): WorkingTreeState {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
  const unstaged = gitChecked(cwd, ["diff", "--name-only"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
  const untracked = gitChecked(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
  return {
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
    staged,
    unstaged,
    untracked,
  }
}

export function resolveReviewTarget(
  cwd: string,
  options: ReviewTargetOptions = {},
): ReviewTarget {
  ensureGitRepository(cwd)
  const requestedScope = options.scope ?? "auto"
  const baseRef = options.base ?? null
  const state = getWorkingTreeState(cwd)
  const supportedScopes = new Set(["auto", "branch", "working-tree"])
  if (baseRef) {
    return {
      baseRef,
      explicit: true,
      label: `branch diff against ${baseRef}`,
      mode: "branch" as const,
    }
  }
  if (requestedScope === "working-tree") {
    return {
      explicit: true,
      label: "working tree diff",
      mode: "working-tree" as const,
    }
  }
  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`,
    )
  }
  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd)
    return {
      baseRef: detectedBase,
      explicit: true,
      label: `branch diff against ${detectedBase}`,
      mode: "branch" as const,
    }
  }
  if (state.isDirty) {
    return {
      explicit: false,
      label: "working tree diff",
      mode: "working-tree" as const,
    }
  }
  const detectedBase = detectDefaultBranch(cwd)
  return {
    baseRef: detectedBase,
    explicit: false,
    label: `branch diff against ${detectedBase}`,
    mode: "branch" as const,
  }
}

function formatSection(title: string, body: string): string {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join(
    "\n",
  )
}

function formatUntrackedFile(cwd: string, relativePath: string): string {
  const absolutePath = path.join(cwd, relativePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolutePath)
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`
  }
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(absolutePath)
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`
  }
  return [
    `### ${relativePath}`,
    "```",
    buffer.toString("utf8").trimEnd(),
    "```",
  ].join("\n")
}

interface CollectWorkingTreeOptions {
  includeDiff?: boolean
}

interface WorkingTreeContext {
  changedFiles: string[]
  content: string
  mode: "working-tree"
  summary: string
}

function collectWorkingTreeContext(
  cwd: string,
  state: WorkingTreeState,
  options: CollectWorkingTreeOptions = {},
): WorkingTreeContext {
  const includeDiff = options.includeDiff !== false
  const status = gitChecked(cwd, [
    "status",
    "--short",
    "--untracked-files=all",
  ]).stdout.trim()
  const changedFiles = listUniqueFiles(
    state.staged,
    state.unstaged,
    state.untracked,
  )
  let parts: string[]
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--submodule=diff",
    ]).stdout
    const unstagedDiff = gitChecked(cwd, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--submodule=diff",
    ]).stdout
    const untrackedBody = state.untracked
      .map((file) => formatUntrackedFile(cwd, file))
      .join("\n\n")
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody),
    ]
  } else {
    const stagedStat = gitChecked(cwd, [
      "diff",
      "--shortstat",
      "--cached",
    ]).stdout.trim()
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim()
    const untrackedBody = state.untracked
      .map((file) => formatUntrackedFile(cwd, file))
      .join("\n\n")
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody),
    ]
  }
  return {
    changedFiles,
    content: parts.join("\n"),
    mode: "working-tree" as const,
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
  }
}

interface CollectBranchOptions {
  comparison?: BranchComparison
  includeDiff?: boolean
}

interface BranchContext {
  changedFiles: string[]
  comparison: BranchComparison
  content: string
  mode: "branch"
  summary: string
}

function collectBranchContext(
  cwd: string,
  baseRef: string,
  options: CollectBranchOptions = {},
): BranchContext {
  const includeDiff = options.includeDiff !== false
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef)
  const currentBranch = getCurrentBranch(cwd)
  const changedFiles = gitChecked(cwd, [
    "diff",
    "--name-only",
    comparison.commitRange,
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
  const logOutput = gitChecked(cwd, [
    "log",
    "--oneline",
    "--decorate",
    comparison.commitRange,
  ]).stdout.trim()
  const diffStat = gitChecked(cwd, [
    "diff",
    "--stat",
    comparison.commitRange,
  ]).stdout.trim()
  return {
    changedFiles,
    comparison,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--submodule=diff",
              comparison.commitRange,
            ]).stdout,
          ),
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n")),
        ].join("\n"),
    mode: "branch" as const,
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
  }
}

function buildAdversarialCollectionGuidance(
  options: { includeDiff?: boolean } = {},
): string {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence."
  }
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings."
}

export function collectReviewContext(
  cwd: string,
  target: ReviewTarget,
  options: CollectContextOptions = {},
): ReviewContext {
  const repoRoot = getRepoRoot(cwd)
  const currentBranch = getCurrentBranch(repoRoot)
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles)
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(
    options.maxInlineDiffBytes,
  )
  let details: BranchContext | WorkingTreeContext
  let includeDiff: boolean
  let diffBytes: number
  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot)
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
      ],
      maxInlineDiffBytes,
    )
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <=
        maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes)
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff })
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef)
    const fileCount = gitChecked(repoRoot, [
      "diff",
      "--name-only",
      comparison.commitRange,
    ])
      .stdout.trim()
      .split("\n")
      .filter(Boolean).length
    diffBytes = measureGitOutputBytes(
      repoRoot,
      [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--submodule=diff",
        comparison.commitRange,
      ],
      maxInlineDiffBytes,
    )
    includeDiff =
      options.includeDiff ??
      (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes)
    details = collectBranchContext(repoRoot, target.baseRef, {
      comparison,
      includeDiff,
    })
  }
  return {
    branch: currentBranch,
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    cwd: repoRoot,
    diffBytes,
    fileCount: details.changedFiles.length,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    repoRoot,
    target,
    ...details,
  }
}
