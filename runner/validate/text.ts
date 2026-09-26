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
const MARKER_AT_END = new RegExp(`${MARKER_SOURCE}\\s*$`);
const MARKER_AT_START = new RegExp(`^${MARKER_SOURCE}`);
const LABEL = /C\d{1,4}/g;
const STRAY_BRACKET = /\[[^\]]*\]/g;

/** Words that end in a period without ending a sentence, in any case. Compared lowercased, without the final period. */
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "co", "corp", "no", "approx", "dept", "est", "fig", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  // Revision 2, X2.
  "incl", "esp", "excl", "yrs", "avg", "intl", "univ", "govt", "mgmt", "assoc", "al", "cf",
]);

/**
 * Words that end in a period without ending a sentence only when capitalized (revision 3, Y2; the case: revision 4,
 * Z4): short ones a claim may state ("Mt. Hood", "Ft. Worth", "a Lt.", "Mx. Quill"), and titles and addresses ("Gen.",
 * "Rep.", "Rd."). In lower case each is an ordinary word ending its sentence: "a sales rep.", "the next gen.", "6 ft.".
 * A capitalized one that really ends a sentence keeps the next one with it ("on Quill Rd. Shipped …"), the trade the
 * list makes for "Inc." too. Compared lowercased, without the final period.
 */
const CAPITALIZED_ABBREVIATIONS = new Set([
  "mt", "ft", "pt", "lt", "mx", "rd",
  "sgt", "capt", "cpl", "pvt", "col", "gen", "maj", "adm", "cmdr", "rev", "hon", "gov", "sen", "rep", "supt", "ave", "blvd",
]);

/**
 * A dotted abbreviation (revision 2, X2): one or two letters and a period, then parts of up to five letters,
 * each with its period: `B.S.`, `U.S.`, `e.g.`, `Ph.D.`, `B.Eng.`, `B.Tech.`, `M.Phil.`, `D.Phil.`.
 */
const DOTTED = /^[A-Za-z]{1,2}\.(?:[A-Za-z]{1,5}\.)*$/;

/**
 * A dotted word whose two-letter first part is followed by a longer part: two words run together ("it.Won."),
 * never an abbreviation. A two-letter first part takes only short parts after it: `Ph.D.`, `LL.M.`, `Ed.D.`.
 */
const TWO_WORDS_RUN_TOGETHER = /^[A-Za-z]{2}\.[A-Za-z]{3,}\./;

/** One more part of a dotted abbreviation, right after a period: the `D.` of `Ph.D.`, the `Eng.` of `B.Eng.`. */
const DOTTED_PART = /^[A-Za-z]{1,5}\./;

/**
 * What ends a sentence: a run of sentence terminals (`.`, `!`, `?`, the
 * ellipsis `…`, and their fullwidth and ideographic forms, Unicode's
 * Sentence_Terminal) and any closing quotes or brackets after it.
 */
const BOUNDARY = /[\p{Sentence_Terminal}…]+[\p{Pe}\p{Pf}"']*/gu;

/** Line and paragraph breaks: each ends a sentence, as a new line in a document would. */
const LINE_BREAKS = /[\n\v\f\r\u0085\u{2028}\u{2029}]+/u;

/** Invisible format characters (zero-width spaces and joiners, soft hyphens, direction marks): never a word, a break or a digit. */
const INVISIBLE = /\p{Cf}/gu;

/** Opening quotes and brackets that may sit between a sentence end and the next sentence's first letter. */
const OPENERS = /[\p{Ps}\p{Pi}"']/u;

/** The part of a dotted name after its period, which never starts a sentence: `ASP.NET`, `Socket.IO`. */
const DOTTED_NAME_TAIL = /^(?:NET|IO)(?![\p{L}\p{N}])/u;

/**
 * Text as the fact rules read it: compatibility forms folded (NFKC), every
 * decimal digit of any script as its ASCII digit (`٥٠٠` is `500`), invisible
 * format characters removed, and a next-line character read as a space. A
 * sentence and the claims it cites are read the same way, so a fact can't
 * hide behind a character that looks like another, or behind nothing at all.
 */
export function normalizeForChecks(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\u0085/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\p{Nd}/gu, asciiDigit);
}

/**
 * A decimal digit of any script as its ASCII digit. Unicode assigns decimal
 * digits only in contiguous runs from 0 to 9 (a stability policy), so a
 * digit's value is its distance from the start of its run of digits, mod 10.
 */
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0)!;
  if (code >= 0x30 && code <= 0x39) return digit;
  let start = code;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((code - start) % 10);
}

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

/**
 * Whether `word`, ending in a period, is an abbreviation or an initial rather than the end of a sentence: a
 * listed abbreviation (`Inc.`, `incl.`, and capitalized, `Lt.`), an initial (`J. Doe`), or a dotted abbreviation of
 * two parts or more (`B.Eng.`, `e.g.`). A dotted word of one part is an ordinary word ending its sentence unless it
 * is listed or an initial: "… for it. Shipped …" and "… in the UK. Won …" are two sentences, so the first can't
 * ride along uncited with the second. Nor is "it.Won.", two words run together.
 */
export function isAbbreviation(word: string): boolean {
  const bare = word.replace(/^[\p{Ps}\p{Pi}"']+/u, "");
  const lower = bare.replace(/\.$/, "").toLowerCase();
  if (ABBREVIATIONS.has(lower)) return true;
  // "Lt.", never "a sales rep." (Z4), and (P05.1 finding 8) never all-caps "REP.": Z4's capitalization is a proper
  // noun's, one capital letter then lower case, not "however it's cased".
  if (CAPITALIZED_ABBREVIATIONS.has(lower) && /^\p{Lu}\p{Ll}*\.$/u.test(bare)) return true;
  if (/^[A-Z]$/.test(bare.replace(/\.$/, ""))) return true; // an initial, as in "J. Doe"
  const parts = bare.split(".").length - 1;
  return parts >= 2 && DOTTED.test(bare) && !TWO_WORDS_RUN_TOGETHER.test(bare);
}

/**
 * The one-part dotted word a sentence ends in, when it is neither listed nor an initial: "it.", "UK.", "Sq." (revision
 * 3, Y2). Such a word ends its sentence, so when what it ends is refused as uncited, the refusal says where the
 * sentence seemed to end: if the word was an abbreviation, writing it out is the way through.
 */
export function unlistedDottedEnd(sentence: string): string | undefined {
  const last = sentence.trim().split(/\s+/).at(-1) ?? "";
  const word = last.replace(/^[\p{Ps}\p{Pi}"']+/u, "").replace(/[\p{Pe}\p{Pf}"']+$/u, "");
  return /^[A-Za-z]{1,2}\.$/.test(word) && !isAbbreviation(word) ? word : undefined;
}

/** The index of the first character at or after `from` that isn't an invisible format character. */
function nextVisible(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    if (!/^\p{Cf}$/u.test(char)) break;
    index += char.length;
  }
  return index;
}

/** Whether `char` is a capital letter of any script (upper or title case). */
function isCapital(char: string): boolean {
  return /^[\p{Lu}\p{Lt}]$/u.test(char);
}

/**
 * Whether the terminal run `match` (at `match.index` of `text`, within the
 * sentence that began at `start`) ends that sentence, given the first
 * visible character after it, at `next`.
 */
function endsSentence(text: string, start: number, match: RegExpExecArray, next: number): boolean {
  const terminal = match[0];
  // A sentence end right after a citation marker is one, whatever follows: "… [C3].won …".
  if (MARKER_AT_END.test(text.slice(start, match.index))) return true;
  const period = terminal.startsWith(".");
  const following = String.fromCodePoint(text.codePointAt(next)!);

  if (following === " ") {
    // Whatever the next sentence starts with (a capital of any script, a digit, a quote, a lower-case word),
    // a sentence ends here, unless the period ends an abbreviation or an initial ("B.S. in", "J. Doe").
    // The word is read up to the closing brackets or quotes after its period (revision 4, Z2): "(Sr.)" ends in the
    // abbreviation "Sr.". Closed like that, an abbreviation ends the sentence when a capital or a citation marker
    // comes next: "(Sr.) at Fernwood Labs" goes on, "(Inc.) Shipped …" is two sentences.
    const closers = /[\p{Pe}\p{Pf}"']+$/u.exec(terminal)?.[0] ?? "";
    const lastWord = text.slice(start, match.index + terminal.length - closers.length).split(" ").at(-1) ?? "";
    if (!(period && isAbbreviation(lastWord))) return true;
    if (closers === "") return false;
    const after = nextVisible(text, next + 1);
    if (MARKER_AT_START.test(text.slice(after))) return true;
    let letterAt = after;
    while (letterAt < text.length && OPENERS.test(text[letterAt]!)) letterAt = nextVisible(text, letterAt + 1);
    return letterAt < text.length && isCapital(String.fromCodePoint(text.codePointAt(letterAt)!));
  }

  // Nothing between the end and what follows: "… teams.Won …".
  let letterAt = next;
  while (letterAt < text.length && OPENERS.test(text[letterAt]!)) letterAt = nextVisible(text, letterAt + 1);
  const letter = letterAt < text.length ? String.fromCodePoint(text.codePointAt(letterAt)!) : "";
  const opensSentence = isCapital(letter) || MARKER_AT_START.test(text.slice(next));
  if (!opensSentence) return false; // a digit or a lower-case letter: 3.5, Node.js, example.com
  if (period) {
    const tokenStart = text.lastIndexOf(" ", match.index) + 1;
    // The dotted word this period is inside, through the part right after it ("Ph." and "D." in "Ph.D."): a word
    // of one part is an abbreviation only when listed or an initial, so "it.Won" still ends a sentence (X2).
    const part = DOTTED_PART.exec(text.slice(next))?.[0] ?? "";
    if (isAbbreviation(`${text.slice(tokenStart, match.index + 1)}${part}`)) return false; // B.S., Ph.D., U.S., St.Louis
    if (DOTTED_NAME_TAIL.test(text.slice(next))) return false; // ASP.NET, Socket.IO
  }
  return true;
}

/** The sentences of one line of a statement: see `splitSentences`. */
function splitLine(line: string): string[] {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const pieces: string[] = [];
  let start = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    const end = match.index + match[0].length;
    const next = nextVisible(text, end);
    if (next < text.length && !endsSentence(text, start, match, next)) continue;
    pieces.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length) pieces.push(text.slice(start).trim());
  return pieces.filter((piece) => piece.replace(INVISIBLE, "").trim().length > 0);
}

/**
 * Splits one statement into sentences, strictly, so no uncited sentence can
 * ride along with a cited one:
 *
 * - A line break ends a sentence.
 * - A sentence terminal (`.`, `!`, `?`, `…`, or a fullwidth or ideographic
 *   form), with any closing quotes or brackets, ends a sentence when the text
 *   ends there, or a space follows it, whatever comes after the space: a
 *   capital of any script, a digit, a quote, a citation marker or a
 *   lower-case word.
 * - With nothing in between, it ends one when a capital, an opening quote
 *   before one, or a citation marker follows it ("… teams.Won …"), and
 *   always right after a citation marker ("… [C3].won …").
 * - A period never ends one when it ends an abbreviation or an initial
 *   (`B.S.`, `B.Eng.`, `Ph.D.`, `Inc.`, `incl.`, `J. Doe`), sits inside a
 *   number (`3.5`) or a name (`Node.js`, `ASP.NET`). A dotted word of one
 *   part ends one unless it is listed (`Mt.`, `Ft.`, `Lt.`, `Mx.`: revision
 *   3, Y2; those only capitalized: revision 4, Z4): "… for it. Shipped …"
 *   and "… a sales rep. Shipped …" are two sentences (revision 2, X2). An
 *   abbreviation inside a closing bracket or quote ends one only before a
 *   capital or a citation marker: "(Sr.) at …" goes on (revision 4, Z2).
 * - Invisible format characters are looked through, never at.
 *
 * Citation markers that open a sentence (`… Labs. [C1] Maintains …`) belong
 * to the sentence before them.
 */
export function splitSentences(statement: string): string[] {
  const pieces = statement.split(LINE_BREAKS).flatMap(splitLine);

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
    normalizeForChecks(text)
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

/** `text` with every UUID blanked out: an id is the `raw_id` rule's alone, never a number or a date. */
export function withoutUuids(text: string): string {
  return text.replace(new RegExp(UUID_SOURCE, "gi"), " ");
}
