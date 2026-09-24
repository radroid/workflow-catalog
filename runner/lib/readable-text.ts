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
 *
 * Round-1 review fix (logs/handoff/P04-round-1-review.md, decision L3): the
 * original pass used backtracking regexes with `[\s\S]*?` to find a tag's
 * matching close (`<!--...-->`, `<script>...</script>`, etc.). Those are
 * quadratic on hostile input that never supplies the closing marker — 160 KB
 * of unclosed `<!--` took the reviewer's probe about 10 seconds, and the 2
 * MiB fetch cap would put a real hostile page at roughly half an hour to two
 * hours, freezing the bridge for every request in the meantime (this module
 * has no `await` in it at all, so nothing else can run while it spins).
 * Rewritten as one left-to-right pass over the string using `indexOf`: each
 * position is visited once, so the whole thing is linear even when a
 * comment, script or style block never closes (it drops everything from the
 * opening marker to the end of the document, same as `</script>` would have
 * removed it, just with no closing tag to stop at). `</script >` — a space
 * before the `>` — counts as closing, which the plain string `</script>`
 * never would have.
 */

const REMOVE_ENTIRELY_NAMES = new Set(["script", "style", "noscript", "template", "head"]);
/** Tags that separate blocks of text, so "Requirements:</p><ul><li>A</li><li>B</li>" reads as three lines, not one run-on sentence. */
const BLOCK_BOUNDARY_CLOSE_NAMES = new Set(["p", "div", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "pre"]);
const BLOCK_BOUNDARY_OPEN_NAMES = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const VOID_BOUNDARY_NAMES = new Set(["br", "hr"]);
const TAG_NAME_CHAR = /[a-zA-Z0-9]/;
const WHITESPACE_CHAR = /\s/;

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

interface ScannedTag {
  /** Index just past this tag's own `>`, or the string's length when it never closes. */
  readonly end: number;
  /** Lowercase tag name, when this looked like `<name...` or `</name...`. */
  readonly name?: string;
  readonly closing: boolean;
}

/** `html[start]` is `<`. Scans to this tag's own unquoted `>` (an attribute value may itself contain `>`), never past it — one tag is always a bounded scan, so this cannot itself be the source of quadratic behaviour no matter how many tags a document has. */
function scanTag(html: string, start: number): ScannedTag {
  let i = start + 1;
  const closing = html[i] === "/";
  if (closing) i += 1;
  const nameStart = i;
  while (i < html.length && TAG_NAME_CHAR.test(html[i]!)) i += 1;
  const name = i > nameStart ? html.slice(nameStart, i).toLowerCase() : undefined;
  let quote: string | undefined;
  while (i < html.length) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return { end: i + 1, name, closing };
    }
    i += 1;
  }
  return { end: html.length, name, closing };
}

/**
 * Index just past `name`'s closing tag (`</name`, optional whitespace,
 * `>` — so `</script >` counts), searching `lower` (the whole document,
 * already lowercased once by the caller) from `from`. `-1` when it never
 * closes. Each loop iteration advances `pos` past the marker it just
 * rejected, so this is bounded by the document's length regardless of how
 * many near-misses it has to step over.
 */
function findClosingTagEnd(lower: string, from: number, name: string): number {
  const marker = `</${name}`;
  let pos = from;
  for (;;) {
    const idx = lower.indexOf(marker, pos);
    if (idx === -1) return -1;
    let j = idx + marker.length;
    while (j < lower.length && WHITESPACE_CHAR.test(lower[j]!)) j += 1;
    if (lower[j] === ">") return j + 1;
    pos = idx + marker.length;
  }
}

function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const n = html.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }

    const tag = scanTag(html, lt);
    if (tag.name && !tag.closing && REMOVE_ENTIRELY_NAMES.has(tag.name)) {
      const closeEnd = findClosingTagEnd(lower, tag.end, tag.name);
      i = closeEnd === -1 ? n : closeEnd;
      out.push("\n");
      continue;
    }

    if (tag.name) {
      const isBoundary = (tag.closing && BLOCK_BOUNDARY_CLOSE_NAMES.has(tag.name)) || (!tag.closing && BLOCK_BOUNDARY_OPEN_NAMES.has(tag.name)) || VOID_BOUNDARY_NAMES.has(tag.name);
      if (isBoundary) out.push("\n");
    }
    i = tag.end;
  }
  return normalizeHtmlText(decodeEntities(out.join("")));
}

/** `contentType` is the response's own (already validated by the fetch path to be text/html or text/plain). */
export function extractReadableText(body: string, contentType: string): string {
  if (contentType === "text/plain") return normalizePlainText(body);
  return htmlToText(body);
}
