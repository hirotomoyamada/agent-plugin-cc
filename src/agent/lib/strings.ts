export function coerceString(value: unknown, fallback = ""): string {
  if (value == null) {
    return fallback
  }
  if (typeof value === "string") {
    return value
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value)
  }
  return fallback
}
