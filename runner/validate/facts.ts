/**
 * The facts a sentence can assert that the validator checks against the
 * claims it cites (P05, mvp-spec F7, hard-problems.md #2): numbers, dates,
 * job titles and credentials. Each extractor runs on the draft sentence and
 * on each cited claim's text alike, so a sentence passes a rule exactly when
 * its facts are among its cited claims' own.
 *
 * Deterministic and deliberately strict: a presentation change may reword a
 * claim, never change a metric, date, title or credential in it. What these
 * patterns can't tell apart is refused rather than guessed at, and the model
 * rewrites the sentence (the revision pass). Every extractor reads the text
 * through `normalizeForChecks`: any script's digits are ASCII digits, and an
 * invisible character hides nothing.
 */

import { normalizeForChecks, splitSentences } from "./text.ts";

export type NumberUnit = "" | "%" | "x";

/** One quantity in a text: its value and unit as a comparable key (`"500%"`, `"3"`, `"2000000"`), and the word it was written as. */
export interface NumberFact {
  readonly key: string;
  readonly raw: string;
}

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  dozen: 12,
};

/** Words that multiply the number before them: "two hundred", "3 million". */
const SCALE_WORDS: Readonly<Record<string, number>> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

/** Magnitude suffixes on a numeral: "2k", "1.5M", "3bn". */
const SUFFIX_SCALES: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, mm: 1_000_000, b: 1_000_000_000, bn: 1_000_000_000 };

/** Words that state a quantity without a numeral. Each is its own key, so it must appear in a cited claim too. */
const QUANTITY_WORDS: Readonly<Record<string, string>> = {
  dozens: "dozens", hundreds: "hundreds", thousands: "thousands", millions: "millions", billions: "billions",
  doubled: "2x", doubling: "2x", twice: "2x", tripled: "3x", tripling: "3x", quadrupled: "4x", quadrupling: "4x", halved: "0.5x", halving: "0.5x",
};

/**
 * Multiplier words read as whole words only (revision 2, X3): "helped double billing" is 2×, as "doubled" is, and
 * "cut it in half" is what "halved" is. Inside a compound they name something else: a "double-entry" ledger, a
 * "half-duplex" link.
 */
const WHOLE_WORD_QUANTITIES: Readonly<Record<string, string>> = { double: "2x", triple: "3x", quadruple: "4x", half: "0.5x" };

/** "double-digit" and "triple-digit" growth: a quantity of their own, which a cited claim must state too (X3). */
const DIGIT_COUNTS: ReadonlySet<string> = new Set(["double", "triple"]);

/** Fractions read after "a" or "one" ("a third", "one quarter") or a number word ("two thirds"), by denominator (X3). */
const FRACTION_WORDS: Readonly<Record<string, number>> = { third: 3, thirds: 3, quarter: 4, quarters: 4 };

/** "N-fold" written as one word: "tenfold", "threefold" (X3). */
const FOLD_WORD = /^(\p{L}+)fold$/u;

/** The number a token starts with: digits, optionally in comma-separated thousands, and a decimal part. */
const LEADING_NUMBER = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/;

/** A unit or scale glued to a numeral: `40%`, `10x`, `10fold`, `2k`, `1.5M`, `3bn`, each optionally with a `+`. */
const GLUED_SUFFIX = /^(%|x|fold|k|mm|m|bn|b)\+?$/i;

/** A multiplier written before its number: `x2`, `x10`. */
const MULTIPLIER_FIRST = /^x(\d+(?:\.\d+)?)$/i;

function keyOf(value: number, unit: NumberUnit): string {
  return `${Math.round(value * 1_000_000) / 1_000_000}${unit}`;
}

/** A 4-digit year a résumé would state: 1900 to 2099. The date rule checks these, so the number rule skips them. Read on the raw token: "1,950" is a number, not a year. */
export function isYear(raw: string): boolean {
  return /^(19|20)\d{2}$/.test(raw);
}

interface Token {
  readonly text: string;
  /** Whether it is one part of a hyphenated compound: "double" in "double-entry", "zero" in "zero-downtime". */
  readonly compound: boolean;
}

function cleanPart(part: string): string {
  return part.replace(/^[$€£+'.,]+/, "").replace(/[.,']+$/, "");
}

/**
 * Words, numerals and symbols-with-numbers, split at hyphens ("3-person",
 * "twenty-five", "2019-2022") and at a comma that isn't a thousands
 * separator ("3,5", "teams,won"), outer punctuation dropped. The
 * multiplication sign reads as `x` ("2×", "×2").
 */
function tokens(text: string): Token[] {
  const raw =
    normalizeForChecks(text)
      .replace(/[’‘]/g, "'")
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/×/g, "x")
      .match(/[\p{L}\p{N}$€£%.,+'-]+/gu) ?? [];
  const out: Token[] = [];
  for (const token of raw) {
    const hyphenParts = token.split("-");
    const compound = hyphenParts.filter((part) => cleanPart(part) !== "").length > 1;
    for (const hyphenPart of hyphenParts) {
      for (const part of hyphenPart.split(/,(?!\d{3}(?!\d))/)) {
        const cleaned = cleanPart(part);
        if (cleaned) out.push({ text: cleaned, compound });
      }
    }
  }
  return out;
}

/** A scale, percent or multiplier word right after a number: "3 million", "40 percent", "40 per cent", "3 times". */
function trailingUnit(list: readonly string[], at: number): { readonly scale: number; readonly unit: NumberUnit; readonly count: number } {
  const word = (list[at] ?? "").toLowerCase();
  const scale = SCALE_WORDS[word];
  if (scale !== undefined) return { scale, unit: "", count: 1 };
  if (word === "percent") return { scale: 1, unit: "%", count: 1 };
  if (word === "per" && (list[at + 1] ?? "").toLowerCase() === "cent") return { scale: 1, unit: "%", count: 2 };
  if (word === "times" || word === "fold") return { scale: 1, unit: "x", count: 1 };
  return { scale: 1, unit: "", count: 0 };
}

/**
 * Every quantity in `text`: numerals (`3`, `1,200`, `2.5`, `40%`, `10x`,
 * `x10`, `$2M`, `2k`, `8+`, `1e6`), numerals with a unit glued on (`200ms`,
 * `5GB`, `3rd`: the quantity is the number, as it is for `200 ms`), number
 * words (`zero`, `three`, `twenty-five`, `a dozen`), scaled and written-out
 * forms (`two hundred`, `3 million`, `40 percent`), multiplier words
 * (`doubled`, `tenfold`, and whole-word `double`, `triple`, `quadruple`,
 * `half`), `double-digit`, and fractions (`a third`, `a quarter`, `two
 * thirds`). Digits of any script count (`٥٠٠`). A name that starts with a
 * letter (`EC2`, `K8s`, `P99`, `Q3`, `B2B`) is not a quantity, and years
 * (`2019`, and `2019Q3`'s) are left to the date rule. "One" is not counted:
 * as a pronoun it is far too common to be a claim. Nor are ordinals such as
 * "first" and "third": "first-class" and "third-party" are everywhere.
 */
export function numbersIn(text: string): NumberFact[] {
  const found = tokens(text);
  const list = found.map((token) => token.text);
  const facts: NumberFact[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]!;
    const lower = token.toLowerCase();

    const lead = LEADING_NUMBER.exec(token);
    if (lead) {
      const integer = lead[1]!;
      const fraction = lead[2] ?? "";
      const rest = token.slice(lead[0].length);
      const digits = `${integer.replace(/,/g, "")}${fraction}`;
      const glued = GLUED_SUFFIX.exec(rest)?.[1]?.toLowerCase();
      if (rest === "" || rest === "+") {
        if (!fraction && isYear(integer)) continue; // the raw token, commas and all: "1,950" is a number
        const after = trailingUnit(list, index + 1);
        facts.push({ key: keyOf(Number(digits) * after.scale, after.unit), raw: token });
        index += after.count;
      } else if (glued) {
        const unit: NumberUnit = glued === "%" ? "%" : glued === "x" || glued === "fold" ? "x" : "";
        facts.push({ key: keyOf(Number(digits) * (unit ? 1 : (SUFFIX_SCALES[glued] ?? 1)), unit), raw: token });
      } else if (/^e[+-]?\d+$/i.test(rest)) {
        facts.push({ key: keyOf(Number(`${digits}${rest}`), ""), raw: token }); // 1e6
      } else if (!fraction && isYear(integer) && /^\p{L}/u.test(rest)) {
        continue; // a year with letters glued on ("2019Q3"): the date rule reads it
      } else {
        facts.push({ key: keyOf(Number(digits), ""), raw: token }); // a unit glued on: "200ms", "5GB", "3rd"
      }
      continue;
    }
    const multiplier = MULTIPLIER_FIRST.exec(token);
    if (multiplier) {
      facts.push({ key: keyOf(Number(multiplier[1]), "x"), raw: token });
      continue;
    }
    if (/\d/.test(token)) continue; // a letter first: a name such as EC2, K8s, P99, Q3 or B2B

    const quantity = QUANTITY_WORDS[lower];
    if (quantity !== undefined) {
      facts.push({ key: quantity, raw: token });
      continue;
    }

    const next = (list[index + 1] ?? "").toLowerCase();
    // "double-digit growth" states a quantity of its own (X3).
    if (DIGIT_COUNTS.has(lower) && (next === "digit" || next === "digits")) {
      facts.push({ key: `${lower}-digit`, raw: `${token}-${list[index + 1]}` });
      index += 1;
      continue;
    }
    const whole = WHOLE_WORD_QUANTITIES[lower];
    if (whole !== undefined) {
      if (!found[index]!.compound) facts.push({ key: whole, raw: token });
      continue;
    }

    // "tenfold", "threefold": N×, as "10-fold" is (X3).
    const fold = FOLD_WORD.exec(lower)?.[1];
    if (fold !== undefined) {
      const times = SMALL_NUMBER_WORDS[fold] ?? SCALE_WORDS[fold];
      if (times !== undefined) facts.push({ key: keyOf(times, "x"), raw: token });
      continue;
    }

    // "a third", "one quarter", "one-third" (X3). A "third-party" library, or a third party, is no fraction.
    const denominator = FRACTION_WORDS[lower];
    if (denominator !== undefined) {
      const previous = (list[index - 1] ?? "").toLowerCase();
      if ((previous === "a" || previous === "one") && next !== "party" && next !== "parties") {
        facts.push({ key: keyOf(1 / denominator, "x"), raw: `${list[index - 1]} ${token}` });
      }
      continue;
    }

    const small = SMALL_NUMBER_WORDS[lower];
    if (small !== undefined) {
      let value = small;
      let used = 0;
      const units = SMALL_NUMBER_WORDS[next];
      if (small >= 20 && small < 100 && small % 10 === 0 && units !== undefined && units < 10) {
        value += units; // "twenty five", "twenty-five"
        used = 1;
      }
      // "two thirds", "three quarters": a fraction (X3).
      const over = used === 0 ? FRACTION_WORDS[next] : undefined;
      if (over !== undefined && value > 0 && value < over) {
        facts.push({ key: keyOf(value / over, "x"), raw: `${token} ${list[index + 1]}` });
        index += 1;
        continue;
      }
      const after = trailingUnit(list, index + 1 + used);
      facts.push({ key: keyOf(value * after.scale, after.unit), raw: token });
      index += used + after.count;
      continue;
    }

    const scale = SCALE_WORDS[lower];
    if (scale !== undefined && /^(?:a|an|one)$/i.test(list[index - 1] ?? "")) {
      facts.push({ key: keyOf(scale, ""), raw: token }); // "a hundred", "a thousand"
    }
  }
  return facts;
}

// --- Dates -----------------------------------------------------------------

const MONTHS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^jan(?:uary)?$/i, 1], [/^feb(?:ruary)?$/i, 2], [/^mar(?:ch)?$/i, 3], [/^apr(?:il)?$/i, 4], [/^may$/i, 5], [/^june?$/i, 6],
  [/^july?$/i, 7], [/^aug(?:ust)?$/i, 8], [/^sep(?:t(?:ember)?)?$/i, 9], [/^oct(?:ober)?$/i, 10], [/^nov(?:ember)?$/i, 11], [/^dec(?:ember)?$/i, 12],
];

function monthNumber(word: string): number | undefined {
  for (const [pattern, month] of MONTHS) if (pattern.test(word)) return month;
  return undefined;
}

export interface DateFacts {
  /** Every 4-digit year (1900–2099), including one glued to letters ("FY2019", "2019Q3"). */
  readonly years: readonly string[];
  /** Every month named next to a day or a year ("March 2022", "Mar 3, 2022", "3 March 2022"), by number. */
  readonly months: readonly number[];
  /** Years that end something: the second year of a range ("2019–2021", "from 2019 to 2021", "between 2019 and 2021"), or a year after an end word ("until 2021", "left in 2021"). */
  readonly endYears: readonly string[];
  /** The word or mark that says something is still going on ("present", "since", "current", "to date", a range left open: "2019–"), when there is one. */
  readonly openEnd?: string;
  /** Whether it states when something started and never when it ended: "Started at Northwind Labs in 2022." */
  readonly startOnly: boolean;
}

/** Words that join the two ends of a range. "and" joins one only after "between". */
const RANGE_JOINERS = new Set(["-", "to", "until", "till", "through", "thru", "and"]);
/** Words after which a year is when something ended. */
const END_WORDS = new Set(["until", "till", "through", "thru", "left", "leaving", "ended", "ending"]);
/** Words that say when something started. */
const START_WORDS = new Set(["started", "start", "starting", "joined", "join", "joining", "began", "begin", "beginning", "from", "since"]);
/** Words that say something is still going on, wherever they are. */
const OPEN_WORDS = new Set(["present", "current", "currently", "ongoing", "since"]);
/** Words that leave a range open when they end it: "2019 to date", "2019–now", "until today". */
const OPEN_RANGE_ENDS = new Set(["now", "today", "date", "present", "current"]);
/** Words that may sit between an end word or a joiner and its year: "until the end of March 2021". */
const BEFORE_YEAR = new Set(["in", "on", "of", "the", "end", "early", "mid", "late"]);
/** A year followed by a dash and then nothing, or only punctuation: "(2019–)". */
const DANGLING_RANGE = /(?<!\d)(?:19|20)\d{2}\s*-\s*(?=[^\p{L}\p{N}\s-]|$)/u;

/** Every 4-digit year in one word, including one glued to letters ("FY2019", "2019Q3"). */
function yearsInWord(word: string): string[] {
  return word.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? [];
}

function isDay(word: string): boolean {
  return /^\d{1,2}$/.test(word);
}

/**
 * The dates in `text`: its years, its months where a month name sits next
 * to a day or a year, which years end something, and whether it leaves
 * something open (still going on) or states only a start. A bare "may" is a
 * verb, so a month counts only in a date. Seasons are words, not dates.
 */
export function datesIn(text: string): DateFacts {
  const normalized = normalizeForChecks(text).replace(/[‐‑‒–—―−]/g, "-");
  const words = normalized.match(/[\p{L}\p{N}]+|-/gu) ?? [];
  const lower = words.map((word) => word.toLowerCase());
  const years: string[] = [];
  const months: number[] = [];
  const endYears: string[] = [];
  let openEnd: string | undefined;
  /** Whether a year sits just before `at` (past a month or a day): the start of a range. */
  const yearBefore = (at: number): boolean => {
    let back = at - 1;
    while (back >= 0 && at - back <= 3 && (monthNumber(lower[back]!) !== undefined || isDay(lower[back]!))) back -= 1;
    return back >= 0 && isYear(words[back]!);
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    years.push(...yearsInWord(word));
    const month = monthNumber(word);
    if (month !== undefined) {
      const next = words[index + 1] ?? "";
      const afterNext = words[index + 2] ?? "";
      const previous = words[index - 1] ?? "";
      if (isYear(next) || (isDay(next) && isYear(afterNext)) || isDay(previous)) months.push(month);
    }
    if (openEnd === undefined && OPEN_WORDS.has(lower[index]!)) openEnd = lower[index];
    if (openEnd === undefined && OPEN_RANGE_ENDS.has(lower[index]!)) {
      // "2019 to date", "2019–now", "until today"; never "up to date".
      const joiner = lower[index - 1] ?? "";
      const anchored = joiner === "-" || joiner === "to" ? yearBefore(index - 1) : END_WORDS.has(joiner) && joiner !== "left";
      if (anchored) openEnd = joiner === "-" ? `–${lower[index]}` : `${joiner} ${lower[index]}`;
    }
    if (!isYear(word)) continue;

    // Is this year the end of something? Look back past the words that may sit before a year.
    let back = index - 1;
    while (back >= 0 && index - back <= 4 && (BEFORE_YEAR.has(lower[back]!) || monthNumber(lower[back]!) !== undefined || isDay(lower[back]!))) back -= 1;
    const before = lower[back] ?? "";
    if (END_WORDS.has(before)) {
      endYears.push(word);
      continue;
    }
    if (!RANGE_JOINERS.has(before) || !yearBefore(back)) continue;
    if (before === "and") {
      // "between 2019 and 2021" is a range; "in 2019 and 2021" is two dates.
      let first = back - 1;
      while (first >= 0 && !isYear(words[first]!)) first -= 1;
      if (lower[first - 1] !== "between") continue;
    }
    endYears.push(word);
  }
  if (openEnd === undefined && DANGLING_RANGE.test(normalized)) openEnd = "–";

  const startOnly = years.length > 0 && endYears.length === 0 && lower.some((word) => START_WORDS.has(word));
  return { years, months, endYears, ...(openEnd !== undefined ? { openEnd } : {}), startOnly };
}

/** Whether a claim leaves its dates open: it says so ("present", "since", "2019–"), or states a start and no end. */
export function isOpenEnded(dates: DateFacts): boolean {
  return dates.openEnd !== undefined || dates.startOnly;
}

// --- Titles ----------------------------------------------------------------

const ROLE_NOUNS = new Set([
  "engineer", "developer", "manager", "director", "designer", "architect", "scientist", "analyst", "consultant", "specialist", "administrator", "officer",
  "lead", "head", "president", "intern", "researcher", "programmer", "technician", "coordinator", "founder", "cofounder", "owner",
  "principal", "fellow", "associate", "assistant", "executive", "strategist", "editor", "writer", "producer", "supervisor", "chief",
  "cto", "ceo", "cfo", "coo", "cio", "cpo", "vp", "svp", "evp", "avp", "sre", "partner",
]);

/** Words that raise or lower a title: a lower-case phrase with one of these before a role noun is a title too ("staff engineer"). */
const SENIORITY = new Set(["senior", "sr", "staff", "principal", "lead", "junior", "jr", "chief", "head", "distinguished", "associate", "vp", "founding", "executive", "deputy"]);

/** Lower-case words allowed inside a capitalized title: "Head of Platform", "VP of Engineering and Operations". */
const TITLE_CONNECTORS = new Set(["of", "and", "&", "for"]);

/** Words that end a lower-case title phrase: a title is one contiguous run of modifiers and nouns. */
const PHRASE_BREAKS = new Set(["a", "an", "the", "and", "or", "of", "to", "with", "for", "in", "at", "on", "by", "from", "as", "who", "that", "which"]);

/** Abbreviations whose period stays inside a title: "Sr. Platform Engineer". */
const TITLE_ABBREVIATIONS = new Set(["sr", "jr", "snr", "jnr", "assoc", "asst", "exec", "mgr", "dir", "eng", "engr", "vp", "svp", "evp", "avp"]);

/**
 * What follows a phrase that opens a sentence and ends in a role word, when that phrase is a title: "Director at
 * …", "Engineering manager at …", "CTO of …", "Engineer for …", or a comma. A verb-like role word followed by
 * anything else ("Lead the migration", "Head the team") is a verb, not a title.
 */
const AFTER_OPENING_TITLE = new Set(["at", "of", "for"]);

/**
 * Words after which a role phrase is a title: "as a platform engineer", "became head of platform", "promoted to
 * director". A title's words never reach back past one of these (X1): "and became engineering manager" states
 * "engineering manager".
 */
const TITLE_CONTEXTS = new Set(["as", "became", "become", "becoming", "named", "appointed", "promoted", "elected"]);
const ARTICLES = new Set(["a", "an", "the"]);

/** Role words that name what they head right after them, in a word or two, when they open a sentence: "VP engineering at …" (X1). */
const DEPARTMENT_HEADS = new Set(["vp", "svp", "evp", "avp", "director", "head"]);

function bareWord(word: string): string {
  return word.replace(/[,;:.]+$/, "");
}

function isCapitalized(word: string): boolean {
  return /^[\p{Lu}][\p{L}\p{N}&'./-]*$/u.test(word);
}

/** A role word, whole or as one part of a hyphenated or slashed word: "engineer", "co-founder", "platform-engineer". */
function isRoleNoun(word: string): boolean {
  const bare = bareWord(word).toLowerCase();
  if (ROLE_NOUNS.has(bare.replace(/[-/]/g, ""))) return true;
  return bare.split(/[-/]/).some((part) => ROLE_NOUNS.has(part));
}

/** A title as the rule compares it: lowercased, an abbreviation's period dropped, hyphens and slashes as spaces, "&" as "and". */
function titleKey(words: readonly string[]): string {
  return words
    .map((word) => bareWord(word).toLowerCase())
    .join(" ")
    .replace(/[-/]/g, " ")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether the words before `at` (past one article) make what follows a title: "as a …", "became …", "promoted to …". */
function inTitleContext(lower: readonly string[], at: number): boolean {
  let before = at - 1;
  if (ARTICLES.has(lower[before] ?? "")) before -= 1;
  const word = lower[before] ?? "";
  return TITLE_CONTEXTS.has(word) || (word === "to" && lower[before - 1] === "promoted");
}

/**
 * The job titles `text` states, in comparable form (`titleKey`), read one
 * sentence at a time. A sentence's first word is read whatever its case
 * (revision 2, X1): it is capitalized only because it opens the sentence, so
 * "Staff engineer at Harbor" states "staff engineer" as "Staff Engineer at
 * Harbor" does, in a draft and in a claim alike.
 *
 * - A capitalized phrase that names a role ("Senior Platform Engineer",
 *   "Head of the Platform Group", "Sr. Platform Engineer", "Staff
 *   Platform-Engineer"), with a lower-case role word right after it ("Senior
 *   Platform engineer").
 * - A phrase that opens the sentence and ends in a role word, before "at",
 *   "of", "for" or a comma ("Director at Fernwood Labs", "Engineering manager
 *   at …", "CTO, Harbor"). "Lead the migration" and "Head the team" are verbs.
 * - An opening "VP", "Director" or "Head" with what it heads, in a word or
 *   two, before "at", "of", "for" or a comma ("VP engineering at Harbor").
 * - A role phrase with a seniority word before its role word ("senior
 *   platform engineer", "a Senior platform engineer"), with "of X" after it,
 *   an article allowed ("director of the platform group", "engineer of the
 *   year"), or after "as", "became", "named", "appointed" or "promoted to"
 *   ("worked as a platform engineer"). The words before the role word never
 *   reach back past such a word: "and became engineering manager" states
 *   "engineering manager".
 *
 * The validator compares titles whole: a sentence's title must equal one its
 * cited claims state, so "Platform Engineer" doesn't pass on a claim that
 * says "Senior Platform Engineer", and "Staff Engineer" never passes on it.
 */
export function titlesIn(text: string): string[] {
  const titles = new Set<string>();
  for (const sentence of splitSentences(text)) for (const title of sentenceTitles(sentence)) titles.add(title);
  return [...titles];
}

function sentenceTitles(sentence: string): string[] {
  const words = normalizeForChecks(sentence).replace(/[“”"()[\]]/g, " ").split(/\s+/).filter(Boolean);
  const lower = words.map((word) => bareWord(word).toLowerCase());
  const punctuated = words.map((word) => bareWord(word) !== word);
  const capitalized = words.map((word) => isCapitalized(bareWord(word)));
  const titles: string[] = [];

  // Capitalized phrases. One capitalized role word opening the sentence is left to the opening rule below.
  let index = 0;
  while (index < words.length) {
    if (!capitalized[index]) {
      index += 1;
      continue;
    }
    const phrase: string[] = [];
    let cursor = index;
    let stopped = false;
    while (cursor < words.length) {
      const word = words[cursor]!;
      const bare = bareWord(word);
      if (capitalized[cursor]) {
        phrase.push(bare);
        cursor += 1;
        if (bare === word) continue;
        // A comma, colon or full stop ends the phrase, except an abbreviation's period: "Sr. Platform Engineer".
        if (word === `${bare}.` && TITLE_ABBREVIATIONS.has(bare.toLowerCase())) continue;
        stopped = true;
        break;
      }
      // "of", "and", "&" or "for" joins two capitalized words; "of" may take an article: "Head of the Platform Group".
      const article = lower[cursor] === "of" && !punctuated[cursor] && ARTICLES.has(lower[cursor + 1] ?? "") && !punctuated[cursor + 1] ? 1 : 0;
      if (TITLE_CONNECTORS.has(lower[cursor]!) && !punctuated[cursor] && capitalized[cursor + 1 + article]) {
        for (let at = cursor; at <= cursor + article; at += 1) phrase.push(lower[at]!);
        cursor += 1 + article;
        continue;
      }
      break;
    }
    // A lower-case role word right after a phrase that raises a title, or stands where a title does, is part of it:
    // "Senior Platform engineer", "as a Platform engineer". ("Certified Kubernetes administrator" names a certificate.)
    const titleLike = phrase.some((word) => SENIORITY.has(word.toLowerCase())) || inTitleContext(lower, index);
    if (!stopped && titleLike && cursor < words.length && !capitalized[cursor] && isRoleNoun(words[cursor]!)) {
      phrase.push(bareWord(words[cursor]!));
      cursor += 1;
    }
    if (phrase.some(isRoleNoun) && !(index === 0 && phrase.length === 1)) titles.push(titleKey(phrase));
    index = Math.max(cursor, index + 1);
  }

  // Role phrases in lower case, and the sentence's first word whatever its case.
  const plain = (at: number) => at >= 0 && at < words.length && !PHRASE_BREAKS.has(lower[at]!) && (at === 0 || !capitalized[at]);
  /** A word the phrase before a role word can take: plain, or a capitalized seniority word ("a Senior platform engineer"); never past punctuation or a context word. */
  const extendsLeft = (at: number) =>
    at >= 0 && !punctuated[at] && !PHRASE_BREAKS.has(lower[at]!) && !TITLE_CONTEXTS.has(lower[at]!) && (at === 0 || !capitalized[at] || SENIORITY.has(lower[at]!));
  for (let role = 0; role < words.length; role += 1) {
    if ((role > 0 && capitalized[role]) || !isRoleNoun(words[role]!)) continue;
    // Modifiers before the role word: up to three words.
    let left = role;
    while (role - left < 3 && extendsLeft(left - 1)) left -= 1;
    let start = role;
    for (let at = left; at < role; at += 1) {
      if (SENIORITY.has(lower[at]!)) {
        start = at;
        break;
      }
    }
    // "of X" after it: up to three words, after an article if there is one.
    let end = role;
    if (!punctuated[role] && lower[role + 1] === "of") {
      let at = role + 2;
      if (ARTICLES.has(lower[at] ?? "") && !punctuated[at]) at += 1;
      const first = at;
      while (at - first < 3 && at < words.length && !PHRASE_BREAKS.has(lower[at]!)) {
        at += 1;
        if (punctuated[at - 1]) break;
      }
      if (at > first) end = at - 1;
    }
    // An opening "VP engineering at …": what it heads, in a word or two, before "at", "of", "for" or a comma.
    if (role === 0 && end === role && DEPARTMENT_HEADS.has(lower[0]!) && !punctuated[0]) {
      let headed = -1;
      for (let at = 1; at <= 2 && plain(at); at += 1) {
        if (punctuated[at]) {
          if (words[at]!.endsWith(",")) headed = at;
          break;
        }
        if (AFTER_OPENING_TITLE.has(lower[at + 1] ?? "")) {
          headed = at;
          break;
        }
      }
      if (headed > 0) {
        titles.push(titleKey(words.slice(0, headed + 1)));
        continue;
      }
    }
    const context = inTitleContext(lower, left);
    // A phrase that opens the sentence and ends in its role word, before "at", "of", "for" or a comma.
    const opening = left === 0 && end === role && (punctuated[role] ? words[role]!.endsWith(",") : AFTER_OPENING_TITLE.has(lower[role + 1] ?? ""));
    if (start === role && end === role && !context && !opening) continue;
    titles.push(titleKey(words.slice(opening ? left : context && start === role ? left : start, end + 1)));
  }
  return titles;
}

// --- Credentials -------------------------------------------------------------

/**
 * Degrees, certifications and licences. Deliberately narrow, so ordinary
 * engineering words don't trip it: no "degree", "license" or "certificate"
 * (a TLS certificate is not a credential), and "master" or "bachelor" only
 * capitalized or possessive ("the master branch" is not a degree). The
 * dotted degrees revision 2 reads whole (X2: `B.Tech.`, `M.Phil.`, `D.Phil.`)
 * are credentials too, so one can't stand in for another.
 */
const CREDENTIAL_PATTERN =
  /(?<![\p{L}.])(?:B\.\s?S\.?|B\.\s?A\.?|B\.\s?Sc\.?|B\.\s?Eng\.?|B\.\s?Tech\.?|M\.\s?S\.?|M\.\s?A\.?|M\.\s?Sc\.?|M\.\s?Eng\.?|M\.\s?Tech\.?|M\.\s?Phil\.?|D\.\s?Phil\.?|BSc|MSc|BEng|MEng|BTech|MTech|MPhil|DPhil|MBA|Ph\.\s?D\.?|PhD|Bachelor(?:'s)?|bachelor's|Master(?:'s)?|master's|[Dd]octorate|[Dd]octoral|[Dd]iploma|[Cc]ertified|[Cc]ertification|[Aa]ccredited|BS|BA|MS|MA)(?![\p{L}])/gu;

/** A credential term in comparable form: lowercased, periods, spaces and apostrophes dropped ("B.S." and "BS" are the same). */
function credentialKey(term: string): string {
  return term.toLowerCase().replace(/[.\s'’]/g, "");
}

/** The credential terms `text` states, in comparable form (`"bs"`, `"masters"`, `"certified"`). */
export function credentialsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.normalize("NFKC").replace(/’/g, "'").matchAll(CREDENTIAL_PATTERN)) found.add(credentialKey(match[0]));
  return [...found];
}
