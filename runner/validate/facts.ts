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
 * rewrites the sentence (the revision pass).
 */

export type NumberUnit = "" | "%" | "x";

/** One quantity in a text: its value and unit as a comparable key (`"500%"`, `"3"`, `"2000000"`), and the word it was written as. */
export interface NumberFact {
  readonly key: string;
  readonly raw: string;
}

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
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
  doubled: "2x", doubling: "2x", twice: "2x", tripled: "3x", tripling: "3x", quadrupled: "4x", halved: "0.5x", halving: "0.5x",
};

const NUMERAL = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|x|k|mm|m|bn|b)?\+?$/i;

function keyOf(value: number, unit: NumberUnit): string {
  return `${Math.round(value * 1_000_000) / 1_000_000}${unit}`;
}

/** A 4-digit year a résumé would state: 1900 to 2099. The date rule checks these, so the number rule skips them. */
export function isYear(raw: string): boolean {
  return /^(19|20)\d{2}$/.test(raw);
}

/** Words, numerals and symbols-with-numbers, split at hyphens ("3-person", "twenty-five", "2019-2022"), outer punctuation dropped. */
function tokens(text: string): string[] {
  const raw = text.normalize("NFKC").replace(/[’‘]/g, "'").replace(/[–—]/g, "-").match(/[\p{L}\p{N}$€£%.,+'-]+/gu) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    for (const part of token.split("-")) {
      const cleaned = part.replace(/^[$€£+'.,]+/, "").replace(/[.,']+$/, "");
      if (cleaned) out.push(cleaned);
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
 * `$2M`, `2k`, `8+`), number words (`three`, `twenty-five`, `a dozen`),
 * scaled and written-out forms (`two hundred`, `3 million`, `40 percent`)
 * and multiplier words (`doubled`). A digit glued to letters (`EC2`, `K8s`,
 * `B2B`) is part of a name, not a quantity, and years are left to the date
 * rule. "One" is not counted: as a pronoun it is far too common to be a
 * claim.
 */
export function numbersIn(text: string): NumberFact[] {
  const list = tokens(text);
  const facts: NumberFact[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]!;
    const lower = token.toLowerCase();

    const numeral = NUMERAL.exec(token);
    if (numeral) {
      const digits = `${numeral[1]!.replace(/,/g, "")}${numeral[2] ?? ""}`;
      const suffix = (numeral[3] ?? "").toLowerCase();
      if (!suffix && !numeral[2] && isYear(digits)) continue;
      let value = Number(digits);
      let unit: NumberUnit = "";
      if (suffix === "%") unit = "%";
      else if (suffix === "x") unit = "x";
      else if (suffix) value *= SUFFIX_SCALES[suffix] ?? 1;
      else {
        const after = trailingUnit(list, index + 1);
        value *= after.scale;
        unit = after.unit;
        index += after.count;
      }
      facts.push({ key: keyOf(value, unit), raw: token });
      continue;
    }
    if (/\d/.test(token)) continue; // digits glued to letters: a name such as EC2 or B2B

    const quantity = QUANTITY_WORDS[lower];
    if (quantity !== undefined) {
      facts.push({ key: quantity, raw: token });
      continue;
    }

    const small = SMALL_NUMBER_WORDS[lower];
    if (small !== undefined) {
      let value = small;
      let used = 0;
      const units = SMALL_NUMBER_WORDS[(list[index + 1] ?? "").toLowerCase()];
      if (small >= 20 && small < 100 && small % 10 === 0 && units !== undefined && units < 10) {
        value += units; // "twenty five", "twenty-five"
        used = 1;
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
  /** Every 4-digit year (1900–2099). */
  readonly years: readonly string[];
  /** Every month named next to a day or a year ("March 2022", "Mar 3, 2022", "3 March 2022"), by number. */
  readonly months: readonly number[];
}

/**
 * The dates in `text`: its years, and its months where a month name sits
 * next to a day or a year. A bare "may" is a verb, so a month counts only in
 * a date. Seasons and "present" are words, not dates.
 */
export function datesIn(text: string): DateFacts {
  const words = (text.normalize("NFKC").replace(/[–—]/g, " ").match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word);
  const years: string[] = [];
  const months: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (isYear(word)) years.push(word);
    const month = monthNumber(word);
    if (month === undefined) continue;
    const next = words[index + 1] ?? "";
    const afterNext = words[index + 2] ?? "";
    const previous = words[index - 1] ?? "";
    if (isYear(next) || (/^\d{1,2}$/.test(next) && isYear(afterNext)) || /^\d{1,2}$/.test(previous)) months.push(month);
  }
  return { years, months };
}

// --- Titles ----------------------------------------------------------------

const ROLE_NOUNS = new Set([
  "engineer", "developer", "manager", "director", "designer", "architect", "scientist", "analyst", "consultant", "specialist", "administrator", "officer",
  "lead", "head", "president", "intern", "researcher", "programmer", "technician", "coordinator", "founder", "cofounder", "owner",
  "principal", "fellow", "associate", "assistant", "executive", "strategist", "editor", "writer", "producer", "supervisor", "chief",
  "cto", "ceo", "cfo", "coo", "cio", "cpo", "vp", "sre", "partner",
]);

/** Words that raise or lower a title: a lower-case phrase with one of these before a role noun is a title too ("staff engineer"). */
const SENIORITY = new Set(["senior", "sr", "staff", "principal", "lead", "junior", "jr", "chief", "head", "distinguished", "associate", "vp", "founding", "executive", "deputy"]);

/** Lower-case words allowed inside a capitalized title: "Head of Platform", "VP of Engineering and Operations". */
const TITLE_CONNECTORS = new Set(["of", "and", "&", "for"]);

/** Words that end a lower-case title phrase: a title is one contiguous run of modifiers and nouns. */
const PHRASE_BREAKS = new Set(["a", "an", "the", "and", "or", "of", "to", "with", "for", "in", "at", "on", "by", "from", "as", "who", "that", "which"]);

function bareWord(word: string): string {
  return word.replace(/[,;:.]+$/, "");
}

function isCapitalized(word: string): boolean {
  return /^[\p{Lu}][\p{L}\p{N}&'.-]*$/u.test(word);
}

function isRoleNoun(word: string): boolean {
  return ROLE_NOUNS.has(bareWord(word).toLowerCase().replace(/-/g, ""));
}

/**
 * The job titles `text` states, lowercased: a capitalized phrase that names
 * a role ("Senior Platform Engineer", "Head of Platform"), and a lower-case
 * one with a seniority word before its role noun ("senior platform
 * engineer"). A single capitalized word that opens the sentence is a verb or
 * a name more often than a title ("Lead the migration"), so it doesn't count.
 * The validator compares titles whole: a sentence's title must equal one its
 * cited claims state, so "Platform Engineer" doesn't pass on a claim that
 * says "Senior Platform Engineer", and "Staff Engineer" never passes on it.
 */
export function titlesIn(text: string): string[] {
  const words = text.normalize("NFKC").replace(/[“”"()[\]]/g, " ").split(/\s+/).filter(Boolean);
  const titles = new Set<string>();

  let index = 0;
  while (index < words.length) {
    if (!isCapitalized(bareWord(words[index]!))) {
      index += 1;
      continue;
    }
    const phrase: string[] = [];
    let cursor = index;
    while (cursor < words.length) {
      const word = words[cursor]!;
      const bare = bareWord(word);
      if (isCapitalized(bare)) {
        phrase.push(bare);
        cursor += 1;
        if (bare !== word) break; // a comma, colon or full stop ends the phrase
        continue;
      }
      const following = words[cursor + 1];
      if (TITLE_CONNECTORS.has(word.toLowerCase()) && following !== undefined && isCapitalized(bareWord(following))) {
        phrase.push(word.toLowerCase());
        cursor += 1;
        continue;
      }
      break;
    }
    const hasRole = phrase.some(isRoleNoun);
    if (hasRole && (phrase.length >= 2 || index > 0)) titles.add(phrase.map((word) => word.toLowerCase()).join(" "));
    index = Math.max(cursor, index + 1);
  }

  const lower = words.map((word) => bareWord(word).toLowerCase());
  for (let start = 0; start < lower.length; start += 1) {
    if (!SENIORITY.has(lower[start]!) || isCapitalized(bareWord(words[start]!))) continue;
    for (let end = start + 1; end < Math.min(lower.length, start + 5); end += 1) {
      if (PHRASE_BREAKS.has(lower[end]!) || isCapitalized(bareWord(words[end]!))) break;
      if (ROLE_NOUNS.has(lower[end]!)) {
        titles.add(lower.slice(start, end + 1).join(" "));
        break;
      }
      if (bareWord(words[end]!) !== words[end]) break; // punctuation after a word ends the phrase
    }
  }
  return [...titles];
}

// --- Credentials -------------------------------------------------------------

/**
 * Degrees, certifications and licences. Deliberately narrow, so ordinary
 * engineering words don't trip it: no "degree", "license" or "certificate"
 * (a TLS certificate is not a credential), and "master" or "bachelor" only
 * capitalized or possessive ("the master branch" is not a degree).
 */
const CREDENTIAL_PATTERN =
  /(?<![\p{L}.])(?:B\.\s?S\.?|B\.\s?A\.?|B\.\s?Sc\.?|B\.\s?Eng\.?|M\.\s?S\.?|M\.\s?A\.?|M\.\s?Sc\.?|M\.\s?Eng\.?|BSc|MSc|BEng|MEng|MBA|Ph\.\s?D\.?|PhD|Bachelor(?:'s)?|bachelor's|Master(?:'s)?|master's|[Dd]octorate|[Dd]octoral|[Dd]iploma|[Cc]ertified|[Cc]ertification|[Aa]ccredited|BS|BA|MS|MA)(?![\p{L}])/gu;

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
