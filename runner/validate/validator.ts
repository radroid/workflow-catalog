import type { ClaimKind, ClaimStatus } from "@workflow-catalog/contracts";
import { credentialsIn, datesIn, numbersIn, titlesIn } from "./facts.ts";
import { citedLabels, hasUuid, ngrams, quoteSentence, splitSentences, strayBrackets, stripCitations, uuidsIn, wordsOf } from "./text.ts";

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
 *   state.
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
 * labels. It never names an excluded claim's text or id, so it can go back
 * to the model as it is, and to the person.
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
  readonly refusals: readonly Refusal[];
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

/** The refusals for one sentence. */
function checkSentence(sentence: string, where: DraftLocation, context: Context): Refusal[] {
  const refusals: Refusal[] = [];
  const plain = stripCitations(sentence);
  const quoted = quoteSentence(plain);
  const refuse = (rule: ValidationRule, message: string) => refusals.push({ rule, where, sentence: quoted, message });

  // References to excluded claims, first: by id anywhere in the text.
  const uuids = uuidsIn(sentence);
  if (uuids.some((uuid) => context.excludedIds.has(uuid))) {
    refuse("excluded_claim", "Remove the ID from this sentence, and state only what the confirmed claims you were given say.");
  } else if (uuids.length > 0) {
    refuse("raw_id", "Remove the ID from this sentence; cite claims only by their labels, like [C1].");
  }

  const stray = strayBrackets(sentence).filter((bracket) => !hasUuid(bracket));
  if (stray.length > 0) refuse("stray_marker", "Square brackets are only for claim labels, like [C1]. Take out the other bracketed text.");

  const labels = citedLabels(sentence);
  if (labels.length === 0) {
    refuse("uncited", "Every sentence needs the labels of the confirmed claims it states, like [C1]. Cite them, or take the sentence out.");
    return refusals; // nothing to check facts against
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
  // Unknown and excluded labels get the same words: the model was never told which labels are excluded, and this doesn't tell it.
  if (unknown.length > 0) refuse("unknown_citation", `${listLabels(unknown)} ${unknown.length === 1 ? "isn't one of" : "aren't among"} the confirmed claims you were given. Cite only those.`);
  if (excluded.length > 0) refuse("excluded_claim", `${listLabels(excluded)} ${excluded.length === 1 ? "isn't one of" : "aren't among"} the confirmed claims you were given. Cite only those.`);
  if (unconfirmed.length > 0) refuse("unconfirmed_citation", `${listLabels(unconfirmed)} ${unconfirmed.length === 1 ? "is" : "are"} not confirmed, so ${unconfirmed.length === 1 ? "it" : "they"} can't be cited.`);

  const runs = ngrams(plain, EXCLUDED_WORDING_RUN);
  if ([...runs].some((run) => context.excludedRuns.has(run))) {
    refuse("excluded_claim", "This sentence repeats wording that none of its cited claims support. State only what the cited claims say.");
  }

  const citedText = cited.map((claim) => claim.text).join("\n");
  const citedNames = listLabels(cited.map((claim) => claim.label));
  const citedLabelsNote = cited.length > 0 ? ` (${citedNames})` : "";

  const claimNumbers = new Set(numbersIn(citedText).map((fact) => fact.key));
  const missingNumbers: string[] = [];
  for (const fact of numbersIn(plain)) if (!claimNumbers.has(fact.key) && !missingNumbers.includes(fact.raw)) missingNumbers.push(fact.raw);
  if (missingNumbers.length > 0) {
    refuse("number", `${missingNumbers.map((raw) => `“${raw}”`).join(", ")} ${missingNumbers.length === 1 ? "isn't" : "aren't"} in the claims this sentence cites${citedLabelsNote}. Use only the numbers they state.`);
  }

  const claimDates = datesIn(citedText);
  const sentenceDates = datesIn(plain);
  const missingYears = includesAll(new Set(claimDates.years), sentenceDates.years);
  const missingMonths = includesAll(new Set(claimDates.months), sentenceDates.months);
  if (missingYears.length > 0 || missingMonths.length > 0) {
    const named = [...missingYears.map((year) => `“${year}”`), ...(missingMonths.length > 0 ? ["a month"] : [])].join(" and ");
    refuse("date", `${named} ${missingYears.length + missingMonths.length === 1 ? "isn't" : "aren't"} in the claims this sentence cites${citedLabelsNote}. Dates must match the claims exactly.`);
  }

  const claimTitles = new Set(cited.flatMap((claim) => titlesIn(claim.text)));
  const wrongTitles = titlesIn(plain).filter((title) => !claimTitles.has(title));
  if (wrongTitles.length > 0) {
    refuse("title", `The title ${wrongTitles.map((title) => `“${title}”`).join(", ")} must match a title in the claims this sentence cites${citedLabelsNote} word for word.`);
  }

  const claimCredentials = new Set(credentialsIn(citedText));
  const wrongCredentials = credentialsIn(plain).filter((credential) => !claimCredentials.has(credential));
  if (wrongCredentials.length > 0) {
    refuse("credential", `A degree or certification here isn't in the claims this sentence cites${citedLabelsNote}. Name credentials exactly as the claims do.`);
  }

  const claimRuns = ngrams(citedText, POSTING_WORDING_RUN);
  const copied = [...ngrams(plain, POSTING_WORDING_RUN)].some((run) => context.postingRuns.has(run) && !claimRuns.has(run));
  if (copied) refuse("posting_wording", "This sentence copies wording from the job posting. Describe what the cited claims say instead.");

  return refusals;
}

function checkStatement(statement: string, where: DraftLocation, context: Context): Refusal[] {
  const sentences = splitSentences(statement);
  if (sentences.length === 0) return [{ rule: "empty", where, sentence: "", message: "This entry is empty. Remove it or write a cited sentence." }];
  return sentences.flatMap((sentence) => checkSentence(sentence, where, context));
}

/** Checks a whole draft. `ok` only when there are no refusals. */
export function validateDraft(input: ValidationInput): ValidationResult {
  const context = buildContext(input);
  const refusals: Refusal[] = [];
  const { resume, coverLetter } = input.draft;

  const statementCount = resume.sections.reduce((sum, section) => sum + section.statements.length, 0);
  if (statementCount === 0) refusals.push({ rule: "empty", where: { part: "resume", section: 0, statement: 0 }, sentence: "", message: "The resume has no sentences. Write at least one, citing the claims it states." });

  resume.sections.forEach((section, sectionIndex) => {
    const heading = section.heading;
    if (!(RESUME_HEADINGS as readonly string[]).includes(heading)) {
      refusals.push({
        rule: "heading",
        where: { part: "resume", section: sectionIndex, statement: 0, heading },
        sentence: "",
        message: `“${quoteSentence(heading, 40)}” isn't a section heading the runner uses. Use one of: ${RESUME_HEADINGS.join(", ")}.`,
      });
    }
    section.statements.forEach((statement, statementIndex) => {
      refusals.push(...checkStatement(statement, { part: "resume", section: sectionIndex, statement: statementIndex, heading }, context));
    });
  });

  if (input.coverLetterRequested) {
    const paragraphs = coverLetter?.paragraphs ?? [];
    const sentences = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
    if (sentences === 0) refusals.push({ rule: "empty", where: { part: "cover_letter", section: 0, statement: 0 }, sentence: "", message: "A cover letter was asked for, and it has no sentences. Write it, citing the claims each sentence states." });
  }
  (coverLetter?.paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
    paragraph.forEach((statement, statementIndex) => {
      refusals.push(...checkStatement(statement, { part: "cover_letter", section: paragraphIndex, statement: statementIndex }, context));
    });
  });

  return { ok: refusals.length === 0, refusals };
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
