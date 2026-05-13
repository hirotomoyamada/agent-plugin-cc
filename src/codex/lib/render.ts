import * as core from "../../core/lib/render.js"

import { CODEX_PROVIDER } from "./provider-config.js"

export const renderSetupReport = (report: Record<string, any>) =>
  core.renderSetupReport(CODEX_PROVIDER, report)

export const renderReviewResult = (
  parsedResult: Record<string, any>,
  meta: Record<string, any>,
) => core.renderReviewResult(CODEX_PROVIDER, parsedResult, meta)

export const renderNativeReviewResult = (
  result: Record<string, any>,
  meta: Record<string, any>,
) => core.renderNativeReviewResult(CODEX_PROVIDER, result, meta)

export const renderTaskResult = (
  parsedResult: null | Record<string, any>,
  meta: Record<string, any>,
) => core.renderTaskResult(CODEX_PROVIDER, parsedResult, meta)

export const renderStatusReport = (report: Record<string, any>) =>
  core.renderStatusReport(CODEX_PROVIDER, report)

export const renderJobStatusReport = (job: Record<string, any>) =>
  core.renderJobStatusReport(CODEX_PROVIDER, job)

export const renderStoredJobResult = (
  job: Record<string, any>,
  storedJob: null | Record<string, any>,
) => core.renderStoredJobResult(CODEX_PROVIDER, job, storedJob)

export const renderCancelReport = (job: Record<string, any>) =>
  core.renderCancelReport(CODEX_PROVIDER, job)
