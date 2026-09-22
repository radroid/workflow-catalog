// Small formatting helpers for values read back from the database.
//
// PGlite parses timestamp columns into `Date` objects; Neon's HTTP driver
// transports results as JSON, which has no Date type, so timestamps come
// back as ISO strings. Service code treats every column as `unknown` (see
// SqlRow in lib/db/types.ts) and goes through these helpers rather than
// assuming either shape.

export function toIsoStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toIsoString(value: unknown): string {
  const result = toIsoStringOrNull(value);
  if (result === null) {
    throw new Error("Expected a non-null timestamp value, got null/undefined.");
  }
  return result;
}

export function toStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  return String(value);
}
