import { readJsonFile } from "./fs.js"

export interface ParsedOutputResult {
  [key: string]: unknown
  parsed: null | Record<string, unknown>
  parseError: null | string
  rawOutput: string
}

export function parseStructuredOutput(
  rawOutput: null | string | undefined,
  fallback: Record<string, unknown> = {},
): ParsedOutputResult {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError:
        (fallback.failureMessage as string | undefined) ??
        "Agent did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback,
    }
  }

  try {
    return {
      parsed: JSON.parse(rawOutput) as Record<string, unknown>,
      parseError: null,
      rawOutput,
      ...fallback,
    }
  } catch (error) {
    return {
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
      rawOutput,
      ...fallback,
    }
  }
}

export function readOutputSchema(schemaPath: string): unknown {
  return readJsonFile(schemaPath)
}

export function extractJsonFromText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) {
    return ""
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed
  }
  const fenceMatch =
    /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed) ??
    /```(?:json)?\s*([\s\S]*)/iu.exec(trimmed)
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim()
  }
  const objectStart = trimmed.indexOf("{")
  const arrayStart = trimmed.indexOf("[")
  let cursor = -1
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    cursor = objectStart
  } else if (arrayStart >= 0) {
    cursor = arrayStart
  }
  if (cursor < 0) {
    return trimmed
  }
  return trimmed.slice(cursor)
}
