import type { ClaimKind, ClaimStatus } from "@workflow-catalog/contracts";
import { credentialsIn, datesIn, isOpenEnded, numbersIn, titlesIn } from "./facts.ts";
import { citedLabels, hasUuid, ngrams, quoteSentence, splitSentences, strayBrackets, stripCitations, uuidsIn, withoutUuids, wordsOf } from "./text.ts";

/**
 * The preparation validator (P05, mvp-spec F7, hard-problems.md #2). No
 * model: plain rules over the draft text and the claims, so the same draft
 * always gets the same answer. It runs twice for every preparation: inside
 * `prepare_application` (eve), so the model can revise a refused draft in
 * the same turn, and again in the bridge on the draft the turn accepted,
 * against the profile as it is then, before anything is exported. Citation
 * markers are read here and stripped only at export (`stripCitations`).
 *
 * The rules, per sentence (a bullet or a cover-letter paragraph may hold
 * several):
 *
 * - `uncited`: every sentence cites at least one claim by its label, `[C1]`.
 * - `stray_marker`: square brackets hold claim labels only.
 * - `unknown_citation`: every label is one of the claims this preparation
 *   was given.
 * - `excluded_claim`: nothing references an excluded claim, by label, by
 *   id or by its wording (a run of four words from it that no confirmed
 *   claim shares).
 * - `unconfirmed_citation`: every cited claim is confirmed (a candidate or
 *   disputed claim is not a fact yet).
 * - `raw_id`: no claim id or other UUID in the text; labels only.
 * - `number`: every quantity is one the cited claims state.
 * - `date`: every year, and every month in a date, is one the cited claims
 *   state; a cited claim's end year ("2019–2021") is stated too; and nothing
 *   is said to be still going on ("since 2019", "2019–present") unless a
 *   cited claim is itself open (it says so, or states only a start).
 * - `title`: every job title equals one the cited claims state, word for
 *   word.
 * - `credential`: every degree or certification is one the cited claims
 *   state.
 * - `posting_wording`: no run of six words copied from the job posting that
 *   the cited claims don't also contain. A posting describes the job, not
 *   the person, and its text is data, never material.
 *
 * And per document: `heading` (resume sections use the fixed headings) and
 * `empty` (a resume has at least one sentence; a requested cover letter too).
 *
 * Every refusal's `message` quotes only the draft's own words and claim
 * labels. It never names an excluded claim's text or id. The person sees
 * every refusal as it is (`refusals`); the model sees `forModel`, where a
 * refusal that would tell it a label, an id or some wording belongs to an
 * excluded or unconfirmed claim reads exactly as one for a label or an id it
 * was never given (`unknown_citation`, `raw_id`), so it can't probe what it
 * was never shown.
 */

export const RESUME_HEADINGS = ["Summary", "Experience", "Projects", "Open source", "Education", "Certifications", "Skills"] as const;
export type ResumeHeading = (typeof RESUME_HEADINGS)[number];

export type ValidationRule =
  | "empty"
  | "heading"
  | "uncited"
  | "stray_marker"
  | "unknown_citation"
  | "excluded_claim"
  | "unconfirmed_citation"
  | "raw_id"
  | "number"
  | "date"
  | "title"
  | "credential"
  | "posting_wording";

/** A claim as the validator sees it: its label for this preparation and what the profile says about it. */
export interface ValidationClaim {
  readonly label: string;
  readonly id: string;
  readonly kind: ClaimKind;
  readonly status: ClaimStatus;
  readonly text: string;
}

export interface DraftSection {
  readonly heading: string;
  /** One bullet each; a bullet may hold more than one sentence, and each sentence cites. */
  readonly statements: readonly string[];
}

export interface Draft {
  readonly resume: { readonly sections: readonly DraftSection[] };
  /** Paragraphs of statements. Greeting, date and sign-off are the runner's own, never the model's. */
  readonly coverLetter?: { readonly paragraphs: ReadonlyArray<readonly string[]> };
}

/** Where in the draft a statement is. `section` and `statement` count from 0. */
export interface DraftLocation {
  readonly part: "resume" | "cover_letter";
  readonly section: number;
  readonly statement: number;
  readonly heading?: string;
}

export interface Refusal {
  readonly rule: ValidationRule;
  readonly where: DraftLocation;
  /** The sentence, markers stripped, cut to one line. Empty for a document-level refusal. */
  readonly sentence: string;
  readonly message: string;
}

export interface ValidationInput {
  readonly draft: Draft;
  /** Every claim that has a label in this preparation: confirmed ones, and the rest so a citation of one can be named. */
  readonly claims: readonly ValidationClaim[];
  /** The job posting's own words: its text and its extracted fields. */
  readonly postingText: string;
  /** Whether a cover letter was asked for: then it must be there, and hold at least one sentence. */
  readonly coverLetterRequested: boolean;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Every refusal, by its rule: what the person is shown. */
  readonly refusals: readonly Refusal[];
  /**
   * The same problems as the model is told them: a label of an excluded or
   * unconfirmed claim is named with the labels it was never given, in one
   * `unknown_citation` refusal with the same words; an excluded claim's id is
   * a `raw_id` like any other; its wording is an `unknown_citation`. Empty
   * exactly when `refusals` is.
   */
  readonly forModel: readonly Refusal[];
}

/** What the model is told for an id in a sentence, whoever's it is. */
const RAW_ID_MESSAGE = "Remove the ID from this sentence; cite claims only by their labels, like [C1].";

/** What the model is told for wording from an excluded claim: the same kind of refusal as for a label it was never given. */
const UNSUPPORTED_WORDING_MESSAGE = "This sentence states something that isn't in the confirmed claims you were given. Cite only those, and state only what they say.";

/** "C99 isn't one of the confirmed claims you were given. Cite only those." for one label or several. */
function notGivenMessage(labels: readonly string[]): string {
  return `${listLabels(labels)} ${labels.length === 1 ? "isn't one of" : "aren't among"} the confirmed claims you were given. Cite only those.`;
}

/** How many words in a row from an excluded claim count as its wording, and from a posting as copying it. */
export const EXCLUDED_WORDING_RUN = 4;
export const POSTING_WORDING_RUN = 6;

/** Where a statement is, in plain words: "Resume, Experience, bullet 2" or "Cover letter, paragraph 1, sentence 3". */
export function describeLocation(where: DraftLocation): string {
  if (where.part === "resume") return `Resume, ${where.heading ?? `section ${where.section + 1}`}, bullet ${where.statement + 1}`;
  return `Cover letter, paragraph ${where.section + 1}, sentence ${where.statement + 1}`;
}

function listLabels(labels: readonly string[]): string {
  return labels.join(", ");
}

interface Context {
  readonly byLabel: ReadonlyMap<string, ValidationClaim>;
  readonly excludedIds: ReadonlySet<string>;
  readonly excludedRuns: ReadonlySet<string>;
  readonly postingRuns: ReadonlySet<string>;
}

function buildContext(input: ValidationInput): Context {
  const byLabel = new Map(input.claims.map((claim) => [claim.label, claim]));
  const confirmedRuns = new Set<string>();
  for (const claim of input.claims) if (claim.status === "confirmed") for (const run of ngrams(claim.text, EXCLUDED_WORDING_RUN)) confirmedRuns.add(run);
  const excludedRuns = new Set<string>();
  for (const claim of input.claims) {
    if (claim.status !== "excluded") continue;
    for (const run of ngrams(claim.text, EXCLUDED_WORDING_RUN)) if (!confirmedRuns.has(run)) excludedRuns.add(run);
  }
  return {
    byLabel,
    excludedIds: new Set(input.claims.filter((claim) => claim.status === "excluded").map((claim) => claim.id.toLowerCase())),
    excludedRuns,
    postingRuns: ngrams(input.postingText, POSTING_WORDING_RUN),
  };
}

function includesAll<T>(have: ReadonlySet<T>, want: Iterable<T>): T[] {
  const missing: T[] = [];
  for (const item of want) if (!have.has(item) && !missing.includes(item)) missing.push(item);
  return missing;
}

interface SentenceRefusals {
  /** As the person sees them. */
  readonly refusals: Refusal[];
  /** As the model is told them (see `ValidationResult.forModel`). */
  readonly forModel: Refusal[];
}

/** The refusals for one sentence. */
function checkSentence(sentence: string, where: DraftLocation, context: Context): SentenceRefusals {
  const refusals: Refusal[] = [];
  const forModel: Refusal[] = [];
  const plain = stripCitations(sentence);
  const quoted = quoteSentence(plain);
  /** The sentence as the fact rules read it: an id is the `raw_id` rule's alone, never a number or a date. */
  const facts = withoutUuids(plain);
  /** One refusal. `toModel` is what the model is told instead (null: nothing, it is told with another refusal). */
  const refuse = (rule: ValidationRule, message: string, toModel?: { readonly rule: ValidationRule; readonly message: string } | null) => {
    refusals.push({ rule, where, sentence: quoted, message });
    if (toModel !== null) forModel.push({ rule: toModel?.rule ?? rule, where, sentence: quoted, message: toModel?.message ?? message });
  };

  // References to excluded claims, first: by id anywhere in the text. The model is told it as any other id.
  const uuids = uuidsIn(sentence);
  if (uuids.some((uuid) => context.excludedIds.has(uuid))) {
    refuse("excluded_claim", "Remove the ID from this sentence, and state only what the confirmed claims you were given say.", { rule: "raw_id", message: RAW_ID_MESSAGE });
  } else if (uuids.length > 0) {
    refuse("raw_id", RAW_ID_MESSAGE);
  }

  const stray = strayBrackets(sentence).filter((bracket) => !hasUuid(bracket));
  if (stray.length > 0) refuse("stray_marker", "Square brackets are only for claim labels, like [C1]. Take out the other bracketed text.");

  const labels = citedLabels(sentence);
  if (labels.length === 0) {
    refuse("uncited", "Every sentence needs the labels of the confirmed claims it states, like [C1]. Cite them, or take the sentence out.");
    return { refusals, forModel }; // nothing to check facts against
  }

  const cited: ValidationClaim[] = [];
  const unknown: string[] = [];
  const excluded: string[] = [];
  const unconfirmed: string[] = [];
  for (const label of labels) {
    const claim = context.byLabel.get(label);
    if (!claim) unknown.push(label);
    else if (claim.status === "excluded") excluded.push(label);
    else if (claim.status !== "confirmed") unconfirmed.push(label);
    else cited.push(claim);
  }
  // The person is told which kind each is. The model, never shown an excluded or unconfirmed claim, is told only
  // that these labels aren't among the ones it was given: one refusal, in citation order, the same words whatever
  // their kind, so no label reads differently from one it never had.
  if (unknown.length > 0) refuse("unknown_citation", notGivenMessage(unknown), null);
  if (excluded.length > 0) refuse("excluded_claim", notGivenMessage(excluded), null);
  if (unconfirmed.length > 0) refuse("unconfirmed_citation", `${listLabels(unconfirmed)} ${unconfirmed.length === 1 ? "is" : "are"} not confirmed, so ${unconfirmed.length === 1 ? "it" : "they"} can't be cited.`, null);
  const notGiven = labels.filter((label) => unknown.includes(label) || excluded.includes(label) || unconfirmed.includes(label));
  if (notGiven.length > 0) forModel.push({ rule: "unknown_citation", where, sentence: quoted, message: notGivenMessage(notGiven) });

  const runs = ngrams(plain, EXCLUDED_WORDING_RUN);
  if ([...runs].some((run) => context.excludedRuns.has(run))) {
    refuse("excluded_claim", "This sentence repeats wording that none of its cited claims support. State only what the cited claims say.", {
      rule: "unknown_citation",
      message: UNSUPPORTED_WORDING_MESSAGE,
    });
  }

  const citedText = cited.map((claim) => claim.text).join("\n");
  const citedNames = listLabels(cited.map((claim) => claim.label));
  const citedLabelsNote = cited.length > 0 ? ` (${citedNames})` : "";

  const claimNumbers = new Set(numbersIn(citedText).map((fact) => fact.key));
  const missingNumbers: string[] = [];
  for (const fact of numbersIn(facts)) if (!claimNumbers.has(fact.key) && !missingNumbers.includes(fact.raw)) missingNumbers.push(fact.raw);
  if (missingNumbers.length > 0) {
    refuse("number", `${missingNumbers.map((raw) => `“${raw}”`).join(", ")} ${missingNumbers.length === 1 ? "isn't" : "aren't"} in the claims this sentence cites${citedLabelsNote}. Use only the numbers they state.`);
  }

  // Dates: every year and month the sentence states is its cited claims' own; every end year a cited claim states,
  // the sentence states too; and it says nothing is still going on unless a cited claim does (or states only a start).
  const claimDates = cited.map((claim) => ({ label: claim.label, dates: datesIn(claim.text) }));
  const sentenceDates = datesIn(facts);
  const dateProblems: string[] = [];
  const missingYears = includesAll(new Set(claimDates.flatMap(({ dates }) => dates.years)), sentenceDates.years);
  const missingMonths = includesAll(new Set(claimDates.flatMap(({ dates }) => dates.months)), sentenceDates.months);
  if (missingYears.length > 0 || missingMonths.length > 0) {
    const named = [...missingYears.map((year) => `“${year}”`), ...(missingMonths.length > 0 ? ["a month"] : [])].join(" and ");
    dateProblems.push(`${named} ${missingYears.length + missingMonths.length === 1 ? "isn't" : "aren't"} in the claims this sentence cites${citedLabelsNote}.`);
  }
  for (const { label, dates } of claimDates) {
    const unstated = includesAll(new Set(sentenceDates.years), dates.endYears);
    if (unstated.length > 0) dateProblems.push(`${label} ends in ${unstated.map((year) => `“${year}”`).join(" and ")}, and this sentence doesn't say so.`);
  }
  if (sentenceDates.openEnd !== undefined && !claimDates.some(({ dates }) => isOpenEnded(dates))) {
    dateProblems.push(`“${sentenceDates.openEnd}” says it is still going on, and the claims this sentence cites${citedLabelsNote} don't.`);
  }
  if (dateProblems.length > 0) refuse("date", `${dateProblems.join(" ")} Dates must match the claims exactly.`);

  // Word for word, whatever the case, and a hyphen or space inside the title aside: "Co-founder" is "Cofounder" (X1).
  const sameTitle = (title: string) => title.replace(/\s+/g, "");
  const claimTitles = new Set(cited.flatMap((claim) => titlesIn(claim.text)).map(sameTitle));
  const wrongTitles = titlesIn(facts).filter((title) => !claimTitles.has(sameTitle(title)));
  if (wrongTitles.length > 0) {
    refuse("title", `The title ${wrongTitles.map((title) => `“${title}”`).join(", ")} must match a title in the claims this sentence cites${citedLabelsNote} word for word.`);
  }

  const claimCredentials = new Set(credentialsIn(citedText));
  const wrongCredentials = credentialsIn(facts).filter((credential) => !claimCredentials.has(credential));
  if (wrongCredentials.length > 0) {
    refuse("credential", `A degree or certification here isn't in the claims this sentence cites${citedLabelsNote}. Name credentials exactly as the claims do.`);
  }

  const claimRuns = ngrams(citedText, POSTING_WORDING_RUN);
  const copied = [...ngrams(plain, POSTING_WORDING_RUN)].some((run) => context.postingRuns.has(run) && !claimRuns.has(run));
  if (copied) refuse("posting_wording", "This sentence copies wording from the job posting. Describe what the cited claims say instead.");

  return { refusals, forModel };
}

function checkStatement(statement: string, where: DraftLocation, context: Context): SentenceRefusals {
  const sentences = splitSentences(statement);
  if (sentences.length === 0) {
    const empty: Refusal = { rule: "empty", where, sentence: "", message: "This entry is empty. Remove it or write a cited sentence." };
    return { refusals: [empty], forModel: [empty] };
  }
  const checked = sentences.map((sentence) => checkSentence(sentence, where, context));
  return { refusals: checked.flatMap((entry) => entry.refusals), forModel: checked.flatMap((entry) => entry.forModel) };
}

/** Checks a whole draft. `ok` only when there are no refusals. */
export function validateDraft(input: ValidationInput): ValidationResult {
  const context = buildContext(input);
  const refusals: Refusal[] = [];
  const forModel: Refusal[] = [];
  /** A document-level refusal, told to the person and the model alike. */
  const both = (refusal: Refusal) => {
    refusals.push(refusal);
    forModel.push(refusal);
  };
  const add = (checked: SentenceRefusals) => {
    refusals.push(...checked.refusals);
    forModel.push(...checked.forModel);
  };
  const { resume, coverLetter } = input.draft;

  const statementCount = resume.sections.reduce((sum, section) => sum + section.statements.length, 0);
  if (statementCount === 0) both({ rule: "empty", where: { part: "resume", section: 0, statement: 0 }, sentence: "", message: "The resume has no sentences. Write at least one, citing the claims it states." });

  resume.sections.forEach((section, sectionIndex) => {
    const heading = section.heading;
    if (!(RESUME_HEADINGS as readonly string[]).includes(heading)) {
      both({
        rule: "heading",
        where: { part: "resume", section: sectionIndex, statement: 0, heading },
        sentence: "",
        message: `“${quoteSentence(heading, 40)}” isn't a section heading the runner uses. Use one of: ${RESUME_HEADINGS.join(", ")}.`,
      });
    }
    section.statements.forEach((statement, statementIndex) => {
      add(checkStatement(statement, { part: "resume", section: sectionIndex, statement: statementIndex, heading }, context));
    });
  });

  if (input.coverLetterRequested) {
    const paragraphs = coverLetter?.paragraphs ?? [];
    const sentences = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
    if (sentences === 0) both({ rule: "empty", where: { part: "cover_letter", section: 0, statement: 0 }, sentence: "", message: "A cover letter was asked for, and it has no sentences. Write it, citing the claims each sentence states." });
  }
  (coverLetter?.paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
    paragraph.forEach((statement, statementIndex) => {
      add(checkStatement(statement, { part: "cover_letter", section: paragraphIndex, statement: statementIndex }, context));
    });
  });

  return { ok: refusals.length === 0, refusals, forModel };
}

/** Every sentence of the draft with its location: what the diff and the export walk. */
export function draftStatements(draft: Draft): Array<{ readonly where: DraftLocation; readonly text: string }> {
  const out: Array<{ where: DraftLocation; text: string }> = [];
  draft.resume.sections.forEach((section, sectionIndex) =>
    section.statements.forEach((text, statementIndex) => out.push({ where: { part: "resume", section: sectionIndex, statement: statementIndex, heading: section.heading }, text })),
  );
  (draft.coverLetter?.paragraphs ?? []).forEach((paragraph, paragraphIndex) =>
    paragraph.forEach((text, statementIndex) => out.push({ where: { part: "cover_letter", section: paragraphIndex, statement: statementIndex }, text })),
  );
  return out;
}

/** The words a draft states, lowercased: for a test or a check to search, markers removed. */
export function draftWords(draft: Draft): string[] {
  return draftStatements(draft).flatMap((statement) => wordsOf(stripCitations(statement.text)));
}
