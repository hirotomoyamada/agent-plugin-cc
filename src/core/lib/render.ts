import type { ProviderContext } from "./provider.js"
import { coerceString } from "./strings.js"

function severityRank(severity: string): number {
  switch (severity) {
    case "critical":
      return 0
    case "high":
      return 1
    case "medium":
      return 2
    default:
      return 3
  }
}

interface NormalizedFinding {
  body: string
  file: string
  line_end: null | number
  line_start: null | number
  recommendation: string
  severity: string
  title: string
}

interface NormalizedReviewData {
  findings: NormalizedFinding[]
  next_steps: string[]
  summary: string
  verdict: string
}

function formatLineRange(finding: NormalizedFinding): string {
  if (!finding.line_start) {
    return ""
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`
  }
  return `:${finding.line_start}-${finding.line_end}`
}

function validateReviewResultShape(data: Record<string, any>): null | string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object."
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`."
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`."
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`."
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`."
  }
  return null
}

function normalizeReviewFinding(
  finding: unknown,
  index: number,
): NormalizedFinding {
  const source: Record<string, any> =
    finding && typeof finding === "object" && !Array.isArray(finding)
      ? (finding as Record<string, any>)
      : {}
  const lineStart =
    Number.isInteger(source.line_start) && source.line_start > 0
      ? source.line_start
      : null
  const lineEnd =
    Number.isInteger(source.line_end) &&
    source.line_end > 0 &&
    (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart

  return {
    body:
      typeof source.body === "string" && source.body.trim()
        ? source.body.trim()
        : "No details provided.",
    file:
      typeof source.file === "string" && source.file.trim()
        ? source.file.trim()
        : "unknown",
    line_end: lineEnd as null | number,
    line_start: lineStart as null | number,
    recommendation:
      typeof source.recommendation === "string"
        ? source.recommendation.trim()
        : "",
    severity:
      typeof source.severity === "string" && source.severity.trim()
        ? source.severity.trim()
        : "low",
    title:
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : `Finding ${index + 1}`,
  }
}

function normalizeReviewResultData(
  data: Record<string, any>,
): NormalizedReviewData {
  return {
    findings: data.findings.map((finding: unknown, index: number) =>
      normalizeReviewFinding(finding, index),
    ),
    next_steps: data.next_steps
      .filter(
        (step: unknown) => typeof step === "string" && (step as string).trim(),
      )
      .map((step: string) => step.trim()),
    summary: data.summary.trim(),
    verdict: data.verdict.trim(),
  }
}

function isStructuredReviewStoredResult(
  storedJob: null | Record<string, any>,
): boolean {
  const result = storedJob?.result
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  )
}

function formatJobLine(job: Record<string, any>): string {
  const parts: string[] = [job.id, `${job.status || "unknown"}`]
  if (job.kindLabel) {
    parts.push(job.kindLabel)
  }
  if (job.title) {
    parts.push(job.title)
  }
  return parts.join(" | ")
}

function escapeMarkdownCell(value: unknown): string {
  return coerceString(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

function formatResumeCommand(
  config: ProviderContext,
  job: null | Record<string, any>,
): null | string {
  if (!job?.threadId) {
    return null
  }
  return `${config.cliResumeBinary} resume ${job.threadId}`
}

function appendActiveJobsTable(
  config: ProviderContext,
  lines: string[],
  jobs: Record<string, any>[],
): void {
  lines.push("Active jobs:")
  lines.push(
    `| Job | Kind | Status | Phase | Elapsed | ${config.displayName} Session ID | Summary | Actions |`,
  )
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const job of jobs) {
    const actions: string[] = [`${config.slashPrefix}:status ${job.id}`]
    if (job.status === "queued" || job.status === "running") {
      actions.push(`${config.slashPrefix}:cancel ${job.id}`)
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`,
    )
  }
}

interface JobDetailOptions {
  showCancelHint?: boolean
  showDuration?: boolean
  showElapsed?: boolean
  showLog?: boolean
  showResultHint?: boolean
  showReviewHint?: boolean
}

function pushJobDetails(
  config: ProviderContext,
  lines: string[],
  job: Record<string, any>,
  options: JobDetailOptions = {},
): void {
  lines.push(`- ${formatJobLine(job)}`)
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`)
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`)
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`)
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`)
  }
  if (job.threadId) {
    lines.push(`  ${config.displayName} session ID: ${job.threadId}`)
  }
  const resumeCommand = formatResumeCommand(config, job)
  if (resumeCommand) {
    lines.push(`  Resume in ${config.displayName}: ${resumeCommand}`)
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`)
  }
  if (
    (job.status === "queued" || job.status === "running") &&
    options.showCancelHint
  ) {
    lines.push(`  Cancel: ${config.slashPrefix}:cancel ${job.id}`)
  }
  if (
    job.status !== "queued" &&
    job.status !== "running" &&
    options.showResultHint
  ) {
    lines.push(`  Result: ${config.slashPrefix}:result ${job.id}`)
  }
  if (
    job.status !== "queued" &&
    job.status !== "running" &&
    job.jobClass === "task" &&
    job.write &&
    options.showReviewHint
  ) {
    lines.push(`  Review changes: ${config.slashPrefix}:review --wait`)
    lines.push(
      `  Stricter review: ${config.slashPrefix}:adversarial-review --wait`,
    )
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:")
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`)
    }
  }
}

function appendReasoningSection(
  lines: string[],
  reasoningSummary: null | undefined | unknown[],
): void {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return
  }

  lines.push("", "Reasoning:")
  for (const section of reasoningSummary) {
    lines.push(`- ${coerceString(section)}`)
  }
}

export function renderSetupReport(
  config: ProviderContext,
  report: Record<string, any>,
): string {
  const lines: string[] = [
    `# ${config.displayName} Setup`,
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- ${config.id}: ${report[config.id].detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
  ]

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:")
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`)
    }
    lines.push("")
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:")
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`)
    }
  }

  return `${lines.join("\n").trimEnd()}\n`
}

export function renderReviewResult(
  config: ProviderContext,
  parsedResult: Record<string, any>,
  meta: Record<string, any>,
): string {
  if (!parsedResult.parsed) {
    const lines: string[] = [
      `# ${config.displayName} ${meta.reviewLabel}`,
      "",
      `${config.displayName} did not return valid structured JSON.`,
      "",
      `- Parse error: ${parsedResult.parseError}`,
    ]

    if (parsedResult.rawOutput) {
      lines.push(
        "",
        "Raw final message:",
        "",
        "```text",
        parsedResult.rawOutput,
        "```",
      )
    }

    appendReasoningSection(
      lines,
      meta.reasoningSummary ?? parsedResult.reasoningSummary,
    )

    return `${lines.join("\n").trimEnd()}\n`
  }

  const validationError = validateReviewResultShape(parsedResult.parsed)
  if (validationError) {
    const lines: string[] = [
      `# ${config.displayName} ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      `${config.displayName} returned JSON with an unexpected review shape.`,
      "",
      `- Validation error: ${validationError}`,
    ]

    if (parsedResult.rawOutput) {
      lines.push(
        "",
        "Raw final message:",
        "",
        "```text",
        parsedResult.rawOutput,
        "```",
      )
    }

    appendReasoningSection(
      lines,
      meta.reasoningSummary ?? parsedResult.reasoningSummary,
    )

    return `${lines.join("\n").trimEnd()}\n`
  }

  const data = normalizeReviewResultData(parsedResult.parsed)
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  )
  const lines: string[] = [
    `# ${config.displayName} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ]

  if (findings.length === 0) {
    lines.push("No material findings.")
  } else {
    lines.push("Findings:")
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding)
      lines.push(
        `- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`,
      )
      lines.push(`  ${finding.body}`)
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`)
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:")
    for (const step of data.next_steps) {
      lines.push(`- ${step}`)
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary)

  return `${lines.join("\n").trimEnd()}\n`
}

export function renderNativeReviewResult(
  config: ProviderContext,
  result: Record<string, any>,
  meta: Record<string, any>,
): string {
  const stdout = (result.stdout as string).trim()
  const stderr = (result.stderr as string).trim()
  const lines: string[] = [
    `# ${config.displayName} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    "",
  ]

  if (stdout) {
    lines.push(stdout)
  } else if (result.status === 0) {
    lines.push(
      `${config.displayName} review completed without any stdout output.`,
    )
  } else {
    lines.push(`${config.displayName} review failed.`)
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```")
  }

  appendReasoningSection(lines, meta.reasoningSummary)

  return `${lines.join("\n").trimEnd()}\n`
}

export function renderTaskResult(
  config: ProviderContext,
  parsedResult: null | Record<string, any>,
  _meta: Record<string, any>,
): string {
  const rawOutput =
    typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : ""
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`
  }

  const message =
    String(parsedResult?.failureMessage ?? "").trim() ||
    `${config.displayName} did not return a final message.`
  return `${message}\n`
}

export function renderStatusReport(
  config: ProviderContext,
  report: Record<string, any>,
): string {
  const lines: string[] = [
    `# ${config.displayName} Status`,
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    "",
  ]

  if (report.running.length > 0) {
    appendActiveJobsTable(config, lines, report.running)
    lines.push("")
    lines.push("Live details:")
    for (const job of report.running) {
      pushJobDetails(config, lines, job, {
        showElapsed: true,
        showLog: true,
      })
    }
    lines.push("")
  }

  if (report.latestFinished) {
    lines.push("Latest finished:")
    pushJobDetails(config, lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed",
    })
    lines.push("")
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:")
    for (const job of report.recent) {
      pushJobDetails(config, lines, job, {
        showDuration: true,
        showLog: job.status === "failed",
      })
    }
    lines.push("")
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "")
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.")
    lines.push(
      `Ending the session will trigger a fresh ${config.displayName} adversarial review and block if it finds issues.`,
    )
  }

  return `${lines.join("\n").trimEnd()}\n`
}

export function renderJobStatusReport(
  config: ProviderContext,
  job: Record<string, any>,
): string {
  const lines: string[] = [`# ${config.displayName} Job Status`, ""]
  pushJobDetails(config, lines, job, {
    showCancelHint: true,
    showDuration: job.status !== "queued" && job.status !== "running",
    showElapsed: job.status === "queued" || job.status === "running",
    showLog: true,
    showResultHint: true,
    showReviewHint: true,
  })
  return `${lines.join("\n").trimEnd()}\n`
}

export function renderStoredJobResult(
  config: ProviderContext,
  job: Record<string, any>,
  storedJob: null | Record<string, any>,
): string {
  const threadId =
    (storedJob?.threadId as string | undefined) ??
    (job.threadId as string | undefined) ??
    null
  const resumeCommand = threadId
    ? `${config.cliResumeBinary} resume ${threadId}`
    : null
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = (storedJob.rendered as string).endsWith("\n")
      ? storedJob.rendered
      : `${storedJob.rendered}\n`
    if (!threadId) {
      return output as string
    }
    return `${output}\n${config.displayName} session ID: ${threadId}\nResume in ${config.displayName}: ${resumeCommand}\n`
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" &&
      storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.[config.id]?.stdout === "string" &&
      storedJob.result[config.id].stdout) ||
    ""
  if (rawOutput) {
    const output = (rawOutput as string).endsWith("\n")
      ? rawOutput
      : `${rawOutput}\n`
    if (!threadId) {
      return output as string
    }
    return `${output}\n${config.displayName} session ID: ${threadId}\nResume in ${config.displayName}: ${resumeCommand}\n`
  }

  if (storedJob?.rendered) {
    const output = (storedJob.rendered as string).endsWith("\n")
      ? storedJob.rendered
      : `${storedJob.rendered}\n`
    if (!threadId) {
      return output as string
    }
    return `${output}\n${config.displayName} session ID: ${threadId}\nResume in ${config.displayName}: ${resumeCommand}\n`
  }

  const lines: string[] = [
    `# ${job.title ?? `${config.displayName} Result`}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
  ]

  if (threadId) {
    lines.push(`${config.displayName} session ID: ${threadId}`)
    lines.push(`Resume in ${config.displayName}: ${resumeCommand}`)
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`)
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage)
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage as string)
  } else {
    lines.push("", "No captured result payload was stored for this job.")
  }

  return `${lines.join("\n").trimEnd()}\n`
}

export function renderCancelReport(
  config: ProviderContext,
  job: Record<string, any>,
): string {
  const lines: string[] = [
    `# ${config.displayName} Cancel`,
    "",
    `Cancelled ${job.id}.`,
    "",
  ]

  if (job.title) {
    lines.push(`- Title: ${job.title}`)
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`)
  }
  lines.push(`- Check \`${config.slashPrefix}:status\` for the updated queue.`)

  return `${lines.join("\n").trimEnd()}\n`
}
