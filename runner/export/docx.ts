import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { CoverLetterModel, DocumentModel, ResumeModel } from "./document.ts";

/**
 * DOCX export (P05) with `docx` (pure JavaScript, no native code, no install
 * script, no network: it builds the Office Open XML parts in memory and
 * zips them with JSZip). The same document model as the Markdown and PDF,
 * so all three formats say the same words. Word's own heading and list
 * styles, so the file stays easy to restyle.
 */

function title(model: DocumentModel): string {
  return `${model.kind === "resume" ? "Resume" : "Cover letter"} — ${model.person.name}`;
}

function resumeParagraphs(model: ResumeModel): Paragraph[] {
  const out: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.person.name)] })];
  if (model.person.contact) out.push(new Paragraph({ children: [new TextRun(model.person.contact)], spacing: { after: 200 } }));
  for (const section of model.sections) {
    out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(section.heading)] }));
    for (const statement of section.statements) out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(statement.text)] }));
  }
  return out;
}

function coverLetterParagraphs(model: CoverLetterModel): Paragraph[] {
  const plain = (text: string, after = 200) => new Paragraph({ children: [new TextRun(text)], spacing: { after } });
  const out: Paragraph[] = [plain(model.date), plain(model.greeting)];
  for (const paragraph of model.paragraphs) out.push(plain(paragraph.statements.map((statement) => statement.text).join(" ")));
  out.push(plain(model.signOff), plain(model.person.name, 0));
  if (model.person.contact) out.push(plain(model.person.contact, 0));
  return out;
}

/** The document's author (Word's File › Info) is the person whose document it is, not the runner (revision 1, V18). */
export async function renderDocx(model: DocumentModel): Promise<Buffer> {
  const document = new Document({
    creator: model.person.name,
    lastModifiedBy: model.person.name,
    title: title(model),
    sections: [{ children: model.kind === "resume" ? resumeParagraphs(model) : coverLetterParagraphs(model) }],
  });
  return Packer.toBuffer(document);
}
