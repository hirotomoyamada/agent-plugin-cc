import { readJsonFile } from "./fs.js";
export function parseStructuredOutput(rawOutput, fallback = {}) {
    if (!rawOutput) {
        return {
            parsed: null,
            parseError: fallback.failureMessage ??
                "Agent did not return a final structured message.",
            rawOutput: rawOutput ?? "",
            ...fallback,
        };
    }
    try {
        return {
            parsed: JSON.parse(rawOutput),
            parseError: null,
            rawOutput,
            ...fallback,
        };
    }
    catch (error) {
        return {
            parsed: null,
            parseError: error instanceof Error ? error.message : String(error),
            rawOutput,
            ...fallback,
        };
    }
}
export function readOutputSchema(schemaPath) {
    return readJsonFile(schemaPath);
}
export function extractJsonFromText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return trimmed;
    }
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed) ??
        /```(?:json)?\s*([\s\S]*)/iu.exec(trimmed);
    if (fenceMatch?.[1]) {
        return fenceMatch[1].trim();
    }
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    let cursor = -1;
    if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
        cursor = objectStart;
    }
    else if (arrayStart >= 0) {
        cursor = arrayStart;
    }
    if (cursor < 0) {
        return trimmed;
    }
    return trimmed.slice(cursor);
}
