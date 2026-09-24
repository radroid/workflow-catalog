import { inflateRawSync } from "node:zlib";
import { extractText } from "unpdf";

/**
 * Reads exported documents back as text, for the P05 tests that grep every
 * format (the excluded metric, the hostile posting). A PDF goes through
 * unpdf (PDF.js, the devDependency P05 adds for this); a DOCX is a zip of
 * XML parts, read here with node:zlib, so the tests need no second reader.
 * Test support only: nothing in the runner imports this file.
 */

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Every file in a zip archive, via its central directory. Stored and deflated entries only (all DOCX writers use these). */
export function unzip(archive: Buffer): ZipEntry[] {
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip archive: no end-of-central-directory record.");
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Damaged zip central directory.");
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined;
    if (!data) throw new Error(`Unsupported zip compression method ${method} for ${name}.`);
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** The words of a DOCX's body, one paragraph per line (`word/document.xml`'s `w:t` runs). */
export function docxText(archive: Buffer): string {
  const document = unzip(archive).find((entry) => entry.name === "word/document.xml");
  if (!document) throw new Error("No word/document.xml in this DOCX.");
  const xml = document.data.toString("utf8");
  return xml
    .split(/<\/w:p>/)
    .map((paragraph) => [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => decodeXml(match[1]!)).join(""))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Every XML part of a DOCX, decoded and joined: the body, the styles, the document properties. */
export function docxAllText(archive: Buffer): string {
  return unzip(archive)
    .filter((entry) => entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))
    .map((entry) => decodeXml(entry.data.toString("utf8")))
    .join("\n");
}

/** A PDF's text, every page, as PDF.js extracts it. */
export async function pdfText(file: Buffer): Promise<string> {
  const { text } = await extractText(new Uint8Array(file), { mergePages: true });
  return text;
}

/** Text with runs of whitespace as single spaces, for comparing across formats that wrap lines differently. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
