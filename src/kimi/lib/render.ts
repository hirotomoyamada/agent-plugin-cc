import * as core from "../../core/lib/render.js"

import { KIMI_PROVIDER } from "./provider-config.js"

export const renderSetupReport = (report: Record<string, any>) =>
  core.renderSetupReport(KIMI_PROVIDER, report)

export const renderReviewResult = (
  parsedResult: Record<string, any>,
  meta: Record<string, any>,
) => core.renderReviewResult(KIMI_PROVIDER, parsedResult, meta)

export const renderNativeReviewResult = (
  result: Record<string, any>,
  meta: Record<string, any>,
) => core.renderNativeReviewResult(KIMI_PROVIDER, result, meta)

export const renderTaskResult = (
  parsedResult: null | Record<string, any>,
  meta: Record<string, any>,
) => core.renderTaskResult(KIMI_PROVIDER, parsedResult, meta)

export const renderStatusReport = (report: Record<string, any>) =>
  core.renderStatusReport(KIMI_PROVIDER, report)

export const renderJobStatusReport = (job: Record<string, any>) =>
  core.renderJobStatusReport(KIMI_PROVIDER, job)

export const renderStoredJobResult = (
  job: Record<string, any>,
  storedJob: null | Record<string, any>,
) => core.renderStoredJobResult(KIMI_PROVIDER, job, storedJob)

export const renderCancelReport = (job: Record<string, any>) =>
  core.renderCancelReport(KIMI_PROVIDER, job)
