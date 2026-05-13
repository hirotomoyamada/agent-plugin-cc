import * as core from "../../core/lib/render.js"

import { AGENT_PROVIDER } from "./provider-config.js"

export const renderSetupReport = (report: Record<string, any>) =>
  core.renderSetupReport(AGENT_PROVIDER, report)

export const renderReviewResult = (
  parsedResult: Record<string, any>,
  meta: Record<string, any>,
) => core.renderReviewResult(AGENT_PROVIDER, parsedResult, meta)

export const renderNativeReviewResult = (
  result: Record<string, any>,
  meta: Record<string, any>,
) => core.renderNativeReviewResult(AGENT_PROVIDER, result, meta)

export const renderTaskResult = (
  parsedResult: null | Record<string, any>,
  meta: Record<string, any>,
) => core.renderTaskResult(AGENT_PROVIDER, parsedResult, meta)

export const renderStatusReport = (report: Record<string, any>) =>
  core.renderStatusReport(AGENT_PROVIDER, report)

export const renderJobStatusReport = (job: Record<string, any>) =>
  core.renderJobStatusReport(AGENT_PROVIDER, job)

export const renderStoredJobResult = (
  job: Record<string, any>,
  storedJob: null | Record<string, any>,
) => core.renderStoredJobResult(AGENT_PROVIDER, job, storedJob)

export const renderCancelReport = (job: Record<string, any>) =>
  core.renderCancelReport(AGENT_PROVIDER, job)
