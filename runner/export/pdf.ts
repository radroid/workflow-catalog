import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { CoverLetterModel, DocumentModel, ResumeModel } from "./document.ts";

/**
 * PDF export (P05) with PDFKit (pure JavaScript, no native code, no install
 * script, no network).
 *
 * The text is set in Noto Sans, embedded (revision 1, V16): the regular and
 * bold faces from `@expo-google-fonts/noto-sans` 0.4.2, pinned exactly (the
 * fonts are under the SIL Open Font License 1.1; the package's own files are
 * MIT). PDFKit embeds only the glyphs a document uses. Noto Sans draws Latin
 * with its extensions, Greek, Cyrillic and Vietnamese, among others, so a
 * name like "Zoë Łukasz" or "Ада Квилл" prints as typed.
 *
 * What the font can't draw (Chinese, Japanese and Korean, emoji, Arabic,
 * Hebrew, Thai and more) is never dropped silently: `pdfUnsupported` names
 * it, the PDF prints U+FFFD (�) in its place, and the Applications page
 * warns at the name field and beside the PDF link that the Markdown and Word
 * files keep it. The check and the drawing use the same font engine, fontkit,
 * which is PDFKit's own (reached through PDFKit's resolution, not a
 * dependency of its own), on the same font files.
 *
 * PDFKit ships no type declarations, and the runner may add none as a
 * dependency, so it is loaded through `createRequire` and typed here with
 * just the calls this file makes.
 */

interface PdfDocument {
  registerFont(name: string, src: Buffer): PdfDocument;
  font(name: string): PdfDocument;
  fontSize(size: number): PdfDocument;
  fillColor(color: string): PdfDocument;
  text(text: string, options?: Readonly<Record<string, unknown>>): PdfDocument;
  moveDown(lines?: number): PdfDocument;
  list(items: readonly string[], options?: Readonly<Record<string, unknown>>): PdfDocument;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  end(): void;
}

type PdfDocumentConstructor = new (options: Readonly<Record<string, unknown>>) => PdfDocument;

interface FontkitFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

interface Fontkit {
  create(buffer: Buffer): FontkitFont;
}

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit") as PdfDocumentConstructor;
const fontkit = createRequire(require.resolve("pdfkit"))("fontkit") as Fontkit;

const FONT_FILES = {
  regular: "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf",
  bold: "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf",
} as const;
type Face = keyof typeof FONT_FILES;

interface LoadedFace {
  readonly data: Buffer;
  readonly font: FontkitFont;
}

const LOADED = new Map<Face, LoadedFace>();

/** A face's bytes and its parsed font, read once per process, on first use. */
function face(name: Face): LoadedFace {
  let loaded = LOADED.get(name);
  if (!loaded) {
    const data = readFileSync(require.resolve(FONT_FILES[name]));
    loaded = { data, font: fontkit.create(data) };
    LOADED.set(name, loaded);
  }
  return loaded;
}

/** What the PDF prints for a character its font can't draw. */
export const PDF_REPLACEMENT = "�";

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;
const SPACE = /^\s$/u;

function hasGlyph(char: string): boolean {
  const code = char.codePointAt(0)!;
  return face("regular").font.hasGlyphForCodePoint(code) && face("bold").font.hasGlyphForCodePoint(code);
}

/** Whether both faces draw every visible character of one grapheme cluster (a line break, a space or an invisible format character never counts against it). */
function drawable(cluster: string): boolean {
  for (const char of cluster) {
    if (char === "\n" || SPACE.test(char) || INVISIBLE.test(char)) continue;
    if (!hasGlyph(char)) return false;
  }
  return true;
}

/** The characters in `text` the PDF can't draw, each once, in the order they first appear: what the page warns about. */
export function pdfUnsupported(text: string): string[] {
  const missing: string[] = [];
  for (const { segment } of GRAPHEMES.segment(text.normalize("NFC"))) {
    if (!drawable(segment) && !missing.includes(segment)) missing.push(segment);
  }
  return missing;
}

/**
 * `text` as the PDF prints it: a cluster the font can't draw becomes U+FFFD; a space the font lacks prints as
 * a plain space, and an invisible format character it lacks (a zero-width joiner, say) is left out.
 */
export function pdfSafe(text: string): string {
  let out = "";
  for (const { segment } of GRAPHEMES.segment(text.normalize("NFC"))) {
    if (!drawable(segment)) {
      out += PDF_REPLACEMENT;
      continue;
    }
    for (const char of segment) {
      if (char === "\n" || hasGlyph(char)) out += char;
      else if (SPACE.test(char)) out += " ";
      // an invisible character the font lacks prints as nothing, which is what it is
    }
  }
  return out;
}

/** Every piece of text a document model prints. */
function modelStrings(model: DocumentModel): string[] {
  const person = [model.person.name, model.person.contact];
  if (model.kind === "resume") return [...person, ...model.sections.flatMap((section) => [section.heading, ...section.statements.map((statement) => statement.text)])];
  return [...person, model.date, model.greeting, ...model.paragraphs.flatMap((paragraph) => paragraph.statements.map((statement) => statement.text)), model.signOff];
}

/** The characters `model`'s PDF prints as U+FFFD, each once. Empty when the PDF shows every character. */
export function pdfMissing(model: DocumentModel): string[] {
  return pdfUnsupported(modelStrings(model).join("\n"));
}

const BODY = 10.5;
const INK = "#111111";
const SOFT = "#444444";

function header(doc: PdfDocument, model: ResumeModel): void {
  doc.font("Bold").fontSize(20).fillColor(INK).text(pdfSafe(model.person.name));
  if (model.person.contact) doc.font("Regular").fontSize(BODY).fillColor(SOFT).text(pdfSafe(model.person.contact));
  doc.moveDown(0.8);
}

function drawResume(doc: PdfDocument, model: ResumeModel): void {
  header(doc, model);
  for (const section of model.sections) {
    doc.font("Bold").fontSize(12).fillColor(INK).text(pdfSafe(section.heading), { paragraphGap: 4 });
    doc.font("Regular").fontSize(BODY).fillColor(INK).list(section.statements.map((statement) => pdfSafe(statement.text)), { bulletRadius: 1.6, textIndent: 12, bulletIndent: 4, paragraphGap: 3 });
    doc.moveDown(0.6);
  }
}

/** The template's order: date, greeting, the paragraphs, sign-off, then the name and contact line. */
function drawCoverLetter(doc: PdfDocument, model: CoverLetterModel): void {
  doc.font("Regular").fontSize(BODY).fillColor(INK);
  doc.text(pdfSafe(model.date)).moveDown();
  doc.text(pdfSafe(model.greeting)).moveDown();
  for (const paragraph of model.paragraphs) doc.text(pdfSafe(paragraph.statements.map((statement) => statement.text).join(" ")), { align: "left" }).moveDown();
  doc.text(pdfSafe(model.signOff)).moveDown();
  doc.text(pdfSafe(model.person.name));
  if (model.person.contact) doc.fillColor(SOFT).text(pdfSafe(model.person.contact));
}

export function renderPdf(model: DocumentModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 56, bottom: 56, left: 64, right: 64 },
      lang: "en-US",
      // The document's properties are PDF text strings, which hold any character: the exact name.
      info: { Title: `${model.kind === "resume" ? "Resume" : "Cover letter"} - ${model.person.name}`, Author: model.person.name, Creator: "Job assistant runner" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      doc.registerFont("Regular", face("regular").data);
      doc.registerFont("Bold", face("bold").data);
      if (model.kind === "resume") drawResume(doc, model);
      else drawCoverLetter(doc, model);
      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}
