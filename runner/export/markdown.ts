import { readFile } from "node:fs/promises";
import path from "node:path";
import { JOB_ASSISTANT_DIR } from "../lib/paths.ts";
import { stripCitations } from "../validate/text.ts";
import type { CoverLetterModel, DocumentModel, ResumeModel } from "./document.ts";
import { renderTemplate } from "./template.ts";

/**
 * Markdown export (P05): the job-assistant package's own templates
 * (`templates/resume.md.hbs`, `templates/cover-letter.md.hbs`), rendered
 * with their citation loop, then stripped of every citation marker, line by
 * line. Values are Markdown-escaped, so a statement can't add a link, an
 * image, a heading or HTML to the file.
 */

export const TEMPLATES_DIR = path.join(JOB_ASSISTANT_DIR, "templates");

/** Backslash-escapes the characters that start inline Markdown or HTML. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>|~&]/g, (char) => `\\${char}`).replace(/\n+/g, " ");
}

function templateContext(model: DocumentModel): Record<string, unknown> {
  const statement = (item: { readonly text: string; readonly labels: readonly string[] }) => ({ text: item.text, claimIds: item.labels });
  if (model.kind === "resume") {
    return { person: model.person, sections: model.sections.map((section) => ({ heading: section.heading, statements: section.statements.map(statement) })) };
  }
  return {
    person: model.person,
    date: model.date,
    greeting: model.greeting,
    paragraphs: model.paragraphs.map((paragraph) => ({ statements: paragraph.statements.map(statement) })),
    signOff: model.signOff,
  };
}

/** Strips citation markers from each line, trims line ends, and keeps at most one blank line in a row. */
export function stripDocumentCitations(markdown: string): string {
  const lines = markdown.split("\n").map((line) => {
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return `${indent}${stripCitations(line)}`.replace(/\s+$/, "");
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** The template's own rendering, citations and all: what the exporter strips. */
export function renderCitedMarkdown(model: DocumentModel, templateSource: string): string {
  return renderTemplate(templateSource, templateContext(model), escapeMarkdown);
}

export async function readTemplate(kind: DocumentModel["kind"]): Promise<string> {
  return readFile(path.join(TEMPLATES_DIR, kind === "resume" ? "resume.md.hbs" : "cover-letter.md.hbs"), "utf8");
}

/** The exported Markdown: the template rendered, then every citation marker stripped. */
export async function renderMarkdown(model: ResumeModel | CoverLetterModel, templateSource?: string): Promise<string> {
  return stripDocumentCitations(renderCitedMarkdown(model, templateSource ?? (await readTemplate(model.kind))));
}
