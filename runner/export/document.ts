import { citedLabels, stripCitations } from "../validate/text.ts";
import type { Draft } from "../validate/validator.ts";

/**
 * The document model every export format renders (P05): a resume or a cover
 * letter as plain text, citation markers already stripped (mvp-spec F7:
 * they are stripped only here, at export), with each statement's labels
 * kept beside it for the Markdown template's citation loop and the diff.
 *
 * Only three things in a document are not a validated statement: the
 * person's name and contact line (typed by the person on the Applications
 * page, never seen by the model), the cover letter's greeting, and its
 * date and sign-off. The greeting names the company only when the posting's
 * extracted company name is a plain name (`plainCompanyName`); nothing else
 * from a posting reaches a document, so its text can never become an output.
 */

export interface PersonHeader {
  readonly name: string;
  readonly contact: string;
}

export interface ModelStatement {
  /** Plain text: markers stripped, control characters removed. */
  readonly text: string;
  /** The labels the statement cited, in order. */
  readonly labels: readonly string[];
}

export interface ResumeModel {
  readonly kind: "resume";
  readonly person: PersonHeader;
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly statements: readonly ModelStatement[] }>;
}

export interface CoverLetterModel {
  readonly kind: "cover_letter";
  readonly person: PersonHeader;
  /** Written out: "September 24, 2026". */
  readonly date: string;
  readonly greeting: string;
  readonly paragraphs: ReadonlyArray<{ readonly statements: readonly ModelStatement[] }>;
  readonly signOff: string;
}

export type DocumentModel = ResumeModel | CoverLetterModel;

/** Control characters (other than tab and newline) have no place in a document, and XML refuses them. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function statement(text: string): ModelStatement {
  return { text: cleanText(stripCitations(text)), labels: citedLabels(text) };
}

export function resumeModel(draft: Draft, person: PersonHeader): ResumeModel {
  return {
    kind: "resume",
    person: { name: cleanText(person.name), contact: cleanText(person.contact) },
    sections: draft.resume.sections.map((section) => ({ heading: section.heading, statements: section.statements.map(statement) })),
  };
}

/** Instruction-like words that keep a company name out of the greeting even when it looks like a name. */
const NOT_A_NAME = /\b(?:ignore|instruction|instructions|system|prompt|assistant|tool|call|execute|previous|override|disregard|open_application_group)\b/i;

/**
 * The posting's extracted company name when it reads as a plain name: at
 * most 60 characters and 6 words, letters, digits and `&.,'’-` only, and no
 * word that reads as an instruction. Otherwise undefined, and the greeting
 * says "Dear hiring team,". A company name is posting data; this is the one
 * place any of it may appear in a document.
 */
export function plainCompanyName(company: string | undefined): string | undefined {
  if (!company) return undefined;
  const name = company.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 60 || name.split(" ").length > 6) return undefined;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &.,'’-]*$/u.test(name) || NOT_A_NAME.test(name)) return undefined;
  return name;
}

/**
 * "September 24, 2026", in the runner machine's time zone (revision 3, Y6). The runner runs on the person's own
 * machine, so that is their zone, and the page, which dates things in the browser's, says the same day: at 22:09 on
 * September 24 in Toronto, the letter says September 24, where UTC would already say September 25.
 */
export function letterDate(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(at);
}

export function coverLetterModel(draft: Draft, person: PersonHeader, company: string | undefined, at: Date): CoverLetterModel {
  const name = plainCompanyName(company);
  return {
    kind: "cover_letter",
    person: { name: cleanText(person.name), contact: cleanText(person.contact) },
    date: letterDate(at),
    greeting: name ? `Dear ${name} hiring team,` : "Dear hiring team,",
    paragraphs: (draft.coverLetter?.paragraphs ?? []).map((paragraph) => ({ statements: paragraph.map(statement) })),
    signOff: "Sincerely,",
  };
}

/** Every statement's plain text in a model, in order: what the tests search. */
export function modelText(model: DocumentModel): string {
  const statements = model.kind === "resume" ? model.sections.flatMap((section) => section.statements) : model.paragraphs.flatMap((paragraph) => paragraph.statements);
  return statements.map((item) => item.text).join("\n");
}
