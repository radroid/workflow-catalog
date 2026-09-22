import "./zod-jitless";
import { utf8BoundedTextSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { normalizeWhitespace, truncateToByteCap } from "./text";

describe("normalizeWhitespace", () => {
  it("collapses runs of spaces and tabs", () => {
    expect(normalizeWhitespace("a   b\t\tc")).toBe("a b c");
  });

  it("collapses 3+ blank lines to one blank line", () => {
    expect(normalizeWhitespace("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  \n hello \n  ")).toBe("hello");
  });

  it("strips trailing spaces on a line without merging the newline", () => {
    expect(normalizeWhitespace("line one   \nline two")).toBe("line one\nline two");
  });
});

describe("truncateToByteCap", () => {
  it("returns text unchanged when already under the cap", () => {
    expect(truncateToByteCap("hello", 1000)).toBe("hello");
  });

  it("truncates plain ASCII to fit, and the result validates against the real contracts schema", () => {
    const longText = "word ".repeat(100_000); // way over 200,000 bytes
    const capped = truncateToByteCap(longText, 200_000);
    expect(capped.length).toBeLessThan(longText.length);
    const parsed = utf8BoundedTextSchema(200_000).safeParse(capped);
    expect(parsed.success).toBe(true);
  });

  it("never exceeds the byte cap under adversarial text: control chars, quotes, backslashes, emoji", () => {
    // U+0001 costs 6 bytes as JSON (\u0001); quote/backslash cost 2; a
    // surrogate-pair emoji costs 4 raw UTF-8 bytes but only 1-2 JSON chars
    // escaped-wise (JSON.stringify does not escape it, so it is 4 raw
    // bytes). Repeating this mix stresses the byte/length mismatch that a
    // naive character-count truncation would get wrong.
    const unit = '\u0001"\\\u{1F4BC}';
    const adversarial = unit.repeat(20_000);
    const maxBytes = 1000;

    const capped = truncateToByteCap(adversarial, maxBytes);
    const actualBytes = new TextEncoder().encode(JSON.stringify(capped)).length;
    expect(actualBytes).toBeLessThanOrEqual(maxBytes);

    const parsed = utf8BoundedTextSchema(maxBytes).safeParse(capped);
    expect(parsed.success).toBe(true);
  });

  it("truncating twice at the same cap is idempotent", () => {
    const longText = "x".repeat(500_000);
    const once = truncateToByteCap(longText, 200_000);
    const twice = truncateToByteCap(once, 200_000);
    expect(twice).toBe(once);
  });

  it("handles a cap that lands mid-surrogate-pair without throwing", () => {
    // A run of astral emoji (each a surrogate pair) forces some binary
    // search midpoint to fall between the high and low surrogate for at
    // least one candidate length.
    const emojiRun = "\u{1F4BC}".repeat(1000);
    expect(() => truncateToByteCap(emojiRun, 500)).not.toThrow();
    const capped = truncateToByteCap(emojiRun, 500);
    const actualBytes = new TextEncoder().encode(JSON.stringify(capped)).length;
    expect(actualBytes).toBeLessThanOrEqual(500);
  });
});
