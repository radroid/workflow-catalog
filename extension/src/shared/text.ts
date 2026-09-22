/**
 * Whitespace normalization + the byte-cap truncation the P07 packet
 * requires: "cap with the contracts' text byte cap, which is measured
 * after JSON escaping; import the constant, never hard-code it." Callers
 * pass `MAX_JOB_CAPTURE_TEXT_BYTES` from `@workflow-catalog/contracts`.
 */

/** Collapses runs of spaces/tabs and trims. DOM `innerText` already turns
 * layout into newlines; this keeps the saved text readable and compact
 * without deciding anything about content. */
export function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The exact measure `@workflow-catalog/contracts`'
 * `utf8BoundedTextSchema` enforces: UTF-8 bytes of `JSON.stringify(value)`,
 * quotes included. */
function jsonUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Truncates `text` (assumed already whitespace-normalized) to the largest
 * prefix whose `JSON.stringify`d UTF-8 byte length is at most `maxBytes`,
 * so the result always satisfies
 * `utf8BoundedTextSchema(maxBytes).safeParse(...)`. Binary search over
 * UTF-16 code-unit length rather than a fixed ratio: JSON escaping is not
 * uniform (an ordinary ASCII character costs 1 byte; a control character
 * like U+0001 costs 6, as `\u0001`), so only measuring the actual
 * candidate's serialized byte length at each step is exact for arbitrary
 * (including adversarial) input. A prefix that lands inside a surrogate
 * pair produces a lone surrogate; `JSON.stringify`/`TextEncoder` both
 * handle that without throwing (the lone surrogate serializes as a
 * `\uXXXX` escape / a U+FFFD replacement byte sequence respectively), so
 * the byte bound this function guarantees still holds either way.
 *
 * Returns `text` unchanged when it already fits.
 */
export function truncateToByteCap(text: string, maxBytes: number): string {
  if (jsonUtf8ByteLength(text) <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  // Invariant: text.slice(0, low) fits; text.slice(0, high) does not.
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (jsonUtf8ByteLength(candidate) <= maxBytes) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return text.slice(0, low);
}
