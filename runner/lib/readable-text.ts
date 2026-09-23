/**
 * Turns a fetched page's body into the plain text a job-posting extraction
 * turn reads (P04, mvp-spec F6). No dependency is added for this (runner's
 * `package.json` is out of this packet's `Owns`): a small, dependency-free
 * HTML-to-text pass is enough for a job posting, which is prose and lists,
 * not a layout that needs a real renderer.
 *
 * Never throws: arbitrary, even hostile, HTML is data (hard-problems.md #3).
 * Worst case an odd page extracts to noisy or empty text, which the caller
 * already handles (an empty extraction is refused with a plain message, the
 * same as a page with no readable content at all).
 */

const REMOVE_ENTIRELY = /<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
/** Tags that separate blocks of text: replaced with a newline before the remaining tags are stripped, so "Requirements:</p><ul><li>A</li><li>B</li>" reads as three lines, not one run-on sentence. */
const BLOCK_BOUNDARY = /<\/(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|pre)>|<(br|hr)\s*\/?>|<(p|div|li|tr|h[1-6])\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Collapses runs of spaces/tabs and trims each line. Shared by both content types. */
function normalizeLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n");
}

/** For pasted/fetched plain text: a person's own paragraph breaks are kept, at most one blank line between them. */
function normalizePlainText(text: string): string {
  return normalizeLines(text).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * For HTML: never a blank line. Two adjacent block-level tags (a closing tag
 * immediately followed by another's opening tag, e.g. `</li><li>` or
 * `</h1><p>`) each contribute a boundary newline, which would otherwise leave
 * a blank line between every pair of adjacent elements (fine for prose, but
 * noisy for a list). One line per block-ish unit reads just as well to a
 * model as paragraph-spaced text.
 */
function normalizeHtmlText(text: string): string {
  return normalizeLines(text).replace(/\n{2,}/g, "\n").trim();
}

function htmlToText(html: string): string {
  const withoutRemoved = html.replace(REMOVE_ENTIRELY, "\n").replace(COMMENTS, "");
  const withBoundaries = withoutRemoved.replace(BLOCK_BOUNDARY, "\n");
  const withoutTags = withBoundaries.replace(ANY_TAG, "");
  return normalizeHtmlText(decodeEntities(withoutTags));
}

/** `contentType` is the response's own (already validated by the fetch path to be text/html or text/plain). */
export function extractReadableText(body: string, contentType: string): string {
  if (contentType === "text/plain") return normalizePlainText(body);
  return htmlToText(body);
}
