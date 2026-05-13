import { spawnSync } from "node:child_process"
import process from "node:process"

export interface CommandResult {
  args: string[]
  command: string
  error: Error | null
  signal: null | string
  status: number
  stderr: string
  stdout: string
}

export interface RunCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  maxBuffer?: number
  stdio?: import("node:child_process").StdioOptions
}

export interface TerminateOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  killImpl?: (pid: number, signal?: number | string) => boolean
  platform?: NodeJS.Platform
  runCommandImpl?: typeof runCommand
}

export interface TerminateResult {
  attempted: boolean
  delivered: boolean
  method: null | string
  result?: CommandResult
}

export interface BinaryAvailableResult {
  available: boolean
  detail: string
}

export function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    shell: process.platform === "win32" ? process.env.SHELL || true : false,
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
  })
  return {
    args,
    command,
    error: result.error ?? null,
    signal: result.signal ?? null,
    status: result.status ?? 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  }
}

export function runCommandChecked(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): CommandResult {
  const result = runCommand(command, args, options)
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result))
  }
  return result
}

export function binaryAvailable(
  command: string,
  versionArgs: string[] = ["--version"],
  options: RunCommandOptions = {},
): BinaryAvailableResult {
  const result = runCommand(command, versionArgs, options)
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return { available: false, detail: "not found" }
  }
  if (result.error) {
    return { available: false, detail: result.error.message }
  }
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    return { available: false, detail }
  }
  return {
    available: true,
    detail: result.stdout.trim() || result.stderr.trim() || "ok",
  }
}

function looksLikeMissingProcessMessage(text: string): boolean {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(
    text,
  )
}

export function terminateProcessTree(
  pid: number,
  options: TerminateOptions = {},
): TerminateResult {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null }
  }
  const platform = options.platform ?? process.platform
  const runCommandImpl = options.runCommandImpl ?? runCommand
  const killImpl = options.killImpl ?? process.kill.bind(process)
  if (platform === "win32") {
    const result = runCommandImpl(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      {
        cwd: options.cwd,
        env: options.env,
      },
    )
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result }
    }
    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim()
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result }
    }
    if ((result.error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      try {
        killImpl(pid)
        return { attempted: true, delivered: true, method: "kill" }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" }
        }
        throw error
      }
    }
    if (result.error) {
      throw result.error
    }
    throw new Error(formatCommandFailure(result))
  }
  try {
    killImpl(-pid, "SIGTERM")
    return { attempted: true, delivered: true, method: "process-group" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM")
        return { attempted: true, delivered: true, method: "process" }
      } catch (innerError) {
        if ((innerError as NodeJS.ErrnoException)?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" }
        }
        throw innerError
      }
    }
    return { attempted: true, delivered: false, method: "process-group" }
  }
}

export function formatCommandFailure(result: CommandResult): string {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()]
  if (result.signal) {
    parts.push(`signal=${result.signal}`)
  } else {
    parts.push(`exit=${result.status}`)
  }
  const stderr = (result.stderr || "").trim()
  const stdout = (result.stdout || "").trim()
  if (stderr) {
    parts.push(stderr)
  } else if (stdout) {
    parts.push(stdout)
  }
  return parts.join(": ")
}
