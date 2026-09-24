import { createRequire } from "node:module";
import type { CoverLetterModel, DocumentModel, ResumeModel } from "./document.ts";

/**
 * PDF export (P05) with PDFKit (pure JavaScript, no native code, no install
 * script, no network). It uses the PDF standard font Helvetica, which every
 * reader has built in, so no font file ships or is embedded. That font's
 * WinAnsi encoding covers Latin-1 and common typography (curly quotes,
 * dashes, the bullet, the euro sign); anything else is written in its
 * closest plain form (`toWinAnsi`), and the Markdown and DOCX keep the
 * exact text.
 *
 * PDFKit ships no type declarations, and the runner may add none as a
 * dependency, so it is loaded through `createRequire` and typed here with
 * just the calls this file makes.
 */

interface PdfDocument {
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

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit") as PdfDocumentConstructor;

/** Code points above 0xFF that WinAnsi (and so PDFKit's standard fonts) can still draw. */
const WIN_ANSI_EXTRA = new Set([402, 710, 732, 338, 339, 352, 353, 376, 381, 382, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482]);

const PLAIN_FORMS: Readonly<Record<string, string>> = {
  "‐": "-", "‑": "-", "‒": "-", "−": "-", "―": "—",
  "′": "'", "″": '"', "→": "->", "←": "<-", "↔": "<->",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "​": "", "‌": "", "‍": "", "﻿": "",
  ł: "l", Ł: "L", đ: "d", Đ: "D", ı: "i", ħ: "h", Ħ: "H",
};

function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
}

/** `text` in characters Helvetica's WinAnsi encoding can draw: exact where it can, else the closest plain form, else "?". */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    if (isWinAnsi(char) || char === "\n") out += char;
    else if (PLAIN_FORMS[char] !== undefined) out += PLAIN_FORMS[char];
    else {
      const bare = char.normalize("NFKD").replace(/\p{M}/gu, "");
      out += bare.length > 0 && [...bare].every(isWinAnsi) ? bare : "?";
    }
  }
  return out;
}

const BODY = 10.5;
const INK = "#111111";
const SOFT = "#444444";

function header(doc: PdfDocument, model: ResumeModel): void {
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(toWinAnsi(model.person.name));
  if (model.person.contact) doc.font("Helvetica").fontSize(BODY).fillColor(SOFT).text(toWinAnsi(model.person.contact));
  doc.moveDown(0.8);
}

function drawResume(doc: PdfDocument, model: ResumeModel): void {
  header(doc, model);
  for (const section of model.sections) {
    doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(toWinAnsi(section.heading), { paragraphGap: 4 });
    doc.font("Helvetica").fontSize(BODY).fillColor(INK).list(section.statements.map((statement) => toWinAnsi(statement.text)), { bulletRadius: 1.6, textIndent: 12, bulletIndent: 4, paragraphGap: 3 });
    doc.moveDown(0.6);
  }
}

/** The template's order: date, greeting, the paragraphs, sign-off, then the name and contact line. */
function drawCoverLetter(doc: PdfDocument, model: CoverLetterModel): void {
  doc.font("Helvetica").fontSize(BODY).fillColor(INK);
  doc.text(toWinAnsi(model.date)).moveDown();
  doc.text(toWinAnsi(model.greeting)).moveDown();
  for (const paragraph of model.paragraphs) doc.text(toWinAnsi(paragraph.statements.map((statement) => statement.text).join(" ")), { align: "left" }).moveDown();
  doc.text(toWinAnsi(model.signOff)).moveDown();
  doc.text(toWinAnsi(model.person.name));
  if (model.person.contact) doc.fillColor(SOFT).text(toWinAnsi(model.person.contact));
}

export function renderPdf(model: DocumentModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 56, bottom: 56, left: 64, right: 64 },
      lang: "en-US",
      info: { Title: toWinAnsi(`${model.kind === "resume" ? "Resume" : "Cover letter"} - ${model.person.name}`), Author: toWinAnsi(model.person.name), Creator: "Job assistant runner" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      if (model.kind === "resume") drawResume(doc, model);
      else drawCoverLetter(doc, model);
      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}
