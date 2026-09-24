/**
 * Text helpers for the preparation validator (P05, mvp-spec F7): sentence
 * splitting, citation markers, and the word forms the rules compare. Pure
 * functions with no dependencies, shared by the validator, the
 * `prepare_application` tool (inside eve) and the export step (which strips
 * the markers, and is the only place that does).
 *
 * A citation marker is a claim label in square brackets: `[C3]`, several in
 * one bracket (`[C1, C3]`) or side by side (`[C1][C3]`). The template's own
 * rendering wraps each in backticks (`` `[C3]` ``); both forms are markers.
 * Any other square-bracketed text is a stray marker, which the validator
 * refuses: a label is the only thing a draft may put in brackets.
 */

/** One or more labels in one pair of brackets, optionally wrapped in backticks. */
const MARKER_SOURCE = String.raw`\x60?\[\s*C\d{1,4}(?:\s*,\s*C\d{1,4})*\s*\]\x60?`;
const MARKER = new RegExp(MARKER_SOURCE, "g");
const MARKER_RUN = new RegExp(`(?:\\s*${MARKER_SOURCE})+`, "g");
const LEADING_MARKERS = new RegExp(`^(?:${MARKER_SOURCE}\\s*)+`);
const ONLY_MARKERS = new RegExp(`^(?:\\s*${MARKER_SOURCE})+\\s*$`);
const LABEL = /C\d{1,4}/g;
const STRAY_BRACKET = /\[[^\]]*\]/g;

/** Words that end in a period without ending a sentence. Compared lowercased, without the final period. */
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "co", "corp", "no", "approx", "dept", "est", "fig", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** A dotted abbreviation such as `B.S.`, `U.S.`, `e.g.`, `Ph.D.`: one or two letters, a period, repeated. */
const DOTTED = /^(?:[A-Za-z]{1,2}\.)+$/;

/** The claim labels a text cites, in order, without repeats. */
export function citedLabels(text: string): string[] {
  const labels: string[] = [];
  for (const marker of text.match(MARKER) ?? []) {
    for (const label of marker.match(LABEL) ?? []) if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Square-bracketed text that isn't a citation marker, e.g. `[click here]` or `[5e2907bb-…]`. */
export function strayBrackets(text: string): string[] {
  return (text.replace(MARKER, " ").match(STRAY_BRACKET) ?? []).map((bracket) => bracket.trim());
}

/**
 * The text with every citation marker removed, spacing tidied: no space left
 * before punctuation, runs of spaces collapsed. The export step's one
 * transformation of a statement (mvp-spec F7: citations are stripped only at
 * export); nothing before export calls it on a draft.
 */
export function stripCitations(text: string): string {
  return text
    .replace(MARKER_RUN, "")
    .replace(/[ \t]+([.,;:!?)\]])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Whether a period at `index` of `text` (the end of `word`) ends a sentence. */
function isAbbreviation(word: string): boolean {
  const bare = word.replace(/^[("'“‘]+/, "");
  if (DOTTED.test(bare)) return true;
  const lower = bare.replace(/\.$/, "").toLowerCase();
  if (ABBREVIATIONS.has(lower)) return true;
  return /^[A-Z]$/.test(bare.replace(/\.$/, "")); // an initial, as in "J. Doe"
}

/**
 * Splits one statement into sentences. A sentence ends at `.`, `!` or `?`
 * (after any closing quotes or brackets) followed by whitespace and a
 * capital letter, a digit, an opening quote or a citation marker, or at the
 * end of the text. A period ending an abbreviation (`B.S.`, `Inc.`, an
 * initial) or inside a number (`3.5`) never ends one. Citation markers that
 * open a sentence (`… Labs. [C1] Maintains …`) belong to the sentence
 * before them.
 */
export function splitSentences(statement: string): string[] {
  const text = statement.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const pieces: string[] = [];
  let start = 0;
  const boundary = /[.!?]+["'”’)\]]*(?= |$)/g;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const before = text.slice(start, end);
    const lastWord = before.split(" ").at(-1) ?? "";
    const after = text.slice(end).trimStart();
    if (after.length > 0) {
      if (match[0].startsWith(".") && isAbbreviation(lastWord)) continue;
      if (!/^(?:[A-Z0-9"'“‘(]|\x60?\[\s*C\d)/.test(after)) continue;
    }
    pieces.push(before.trim());
    start = end;
  }
  if (start < text.length) pieces.push(text.slice(start).trim());

  // Markers that open a sentence belong to the one before it.
  const sentences: string[] = [];
  for (const piece of pieces) {
    if (!piece) continue;
    const leading = LEADING_MARKERS.exec(piece)?.[0];
    if (leading && sentences.length > 0) {
      sentences[sentences.length - 1] = `${sentences[sentences.length - 1]} ${leading.trim()}`;
      const rest = piece.slice(leading.length).trim();
      if (rest) sentences.push(rest);
      continue;
    }
    if (ONLY_MARKERS.test(piece) && sentences.length > 0) {
      sentences[sentences.length - 1] = `${sentences[sentences.length - 1]} ${piece.trim()}`;
      continue;
    }
    sentences.push(piece);
  }
  return sentences;
}

/** Lowercased words (letters and digits), for the n-gram rules. `%` stays attached to its number. */
export function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*%?/gu) ?? []
  );
}

/** Every run of `n` consecutive words in `text`, joined by single spaces. */
export function ngrams(text: string, n: number): Set<string> {
  const words = wordsOf(text);
  const out = new Set<string>();
  for (let index = 0; index + n <= words.length; index += 1) out.add(words.slice(index, index + n).join(" "));
  return out;
}

/** A sentence cut to `max` characters on one line, for a refusal to quote. */
export function quoteSentence(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Every UUID in `text` (the shape of every claim id), lowercased. */
export function uuidsIn(text: string): string[] {
  return (text.match(new RegExp(UUID_SOURCE, "gi")) ?? []).map((uuid) => uuid.toLowerCase());
}

/** Whether `text` contains a UUID. */
export function hasUuid(text: string): boolean {
  return new RegExp(UUID_SOURCE, "i").test(text);
}
