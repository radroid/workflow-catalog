import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * PDF and DOCX text extraction for onboarding sources (P03.1, mvp-spec §4
 * Connections "File upload", hard-problems.md #2 "Content is data, never
 * instructions"). Both formats are read entirely in memory; nothing here
 * touches the filesystem — the caller (`server/routes/onboarding.ts`) owns
 * where the raw file and the extracted text land under `sources/<category>/`.
 *
 * PDF: `unpdf` (PDF.js compiled for serverless/Node use, already vetted by
 * P05 for reading exported PDFs back in tests; this packet promotes it from
 * a devDependency to a dependency). No native build step, no install
 * scripts, zero runtime dependencies of its own (`@napi-rs/canvas` is only
 * an optional peer, needed for rendering pages as images — extractText never
 * touches it).
 *
 * DOCX: a DOCX file is a zip of XML parts; `word/document.xml` holds the
 * body. Read with `fflate` (added as a dependency by this packet; see
 * `archive-text.ts`, which shares the same library so the runner needs only
 * one in-memory zip reader). A hand-rolled `<w:t>` run reader is enough —
 * DOCX doesn't need a general XML parser, just the text runs and the
 * paragraph breaks between them.
 *
 * Never throws: a bad password, a truncated file, an empty document or an
 * oversized upload are all plain `DocumentTextResult` refusals, exactly like
 * `safe-fetch.ts` and `readable-text.ts` never throw on hostile input.
 */

export type DocumentKind = "pdf" | "docx";

export type DocumentTextRejectionReason = "too_large" | "encrypted" | "malformed" | "empty" | "timeout" | "zip_bomb";

export type DocumentTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: DocumentTextRejectionReason; readonly message: string };

export interface DocumentTextOptions {
  /** Default 10 MiB (the packet's file-size cap). */
  readonly maxBytes?: number;
  /** Default 20 s: pdf.js has no cancellation hook, so this only bounds how long the caller waits — see `raceTimeout`. */
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

const DOCUMENT_EXTENSIONS: Readonly<Record<string, DocumentKind>> = { pdf: "pdf", docx: "docx" };

/** The document kind for a file name's extension, or undefined when it names neither .pdf nor .docx. */
export function documentKindFromFileName(name: string): DocumentKind | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? DOCUMENT_EXTENSIONS[match[1]!.toLowerCase()] : undefined;
}

const TIMED_OUT = Symbol("document-text-timed-out");

/**
 * Settles with `promise`'s value, or `TIMED_OUT` once `timeoutMs` passes,
 * whichever is first. pdf.js gives no way to cancel an in-flight parse, so a
 * timed-out promise keeps running in the background; this only stops the
 * caller from waiting on it forever. Exported for its own unit test — the
 * fixture corpus has no PDF slow enough to exercise `timeout` for real.
 */
export function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isPasswordException(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "PasswordException";
}

async function pdfText(data: Uint8Array, timeoutMs: number): Promise<DocumentTextResult> {
  let outcome: string | typeof TIMED_OUT;
  try {
    outcome = await raceTimeout(
      (async () => {
        const pdf = await getDocumentProxy(data);
        const { text } = await extractText(pdf, { mergePages: true });
        return text;
      })(),
      timeoutMs,
    );
  } catch (error) {
    if (isPasswordException(error)) return { ok: false, reason: "encrypted", message: "That PDF is password-protected. Remove the password and upload it again." };
    return { ok: false, reason: "malformed", message: "That PDF can't be read. It may be damaged, or not really a PDF." };
  }
  if (outcome === TIMED_OUT) return { ok: false, reason: "timeout", message: `That PDF took longer than ${Math.round(timeoutMs / 1000)} s to read. Try a smaller file.` };
  const trimmed = outcome.trim();
  if (!trimmed) return { ok: false, reason: "empty", message: "That PDF has no extractable text (it may be scanned pages with no text layer)." };
  return { ok: true, text: trimmed };
}

/** The OLE Compound File signature: an encrypted OOXML document is stored this way, not as a plain zip. */
const OLE_SIGNATURE = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

function looksLikeEncryptedOoxml(data: Uint8Array): boolean {
  if (data.length < OLE_SIGNATURE.length) return false;
  for (let i = 0; i < OLE_SIGNATURE.length; i += 1) if (data[i] !== OLE_SIGNATURE[i]) return false;
  return true;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/**
 * Gate fix round 1, B4 (a CPU freeze): this used to be `<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>`. Its attribute
 * group, `[^>]*`, can match across an unbounded run of characters looking for the *nearest* `>` -- on a
 * well-formed document that's the tag's own `>`, a handful of characters away, but on a run of unclosed
 * `<w:t ` fragments with no `>` anywhere nearby, that group scans ahead to the *only* `>` left in the
 * whole remaining string, fails the rest of the pattern (no `</w:t>` follows), and (being global)
 * retries at the very next character -- an O(n) scan repeated at each of O(n) start positions, O(n²)
 * overall (the reviewer's probe: 200 KB of `<w:t ` × N blocked the bridge process for 11.6 s). Excluding
 * `<` from that group too (`[^<>]*`) is enough: real XML attribute values never contain a literal `<`
 * either, so this changes nothing for a genuine document, but it means the group can never scan past
 * the very next `<w:t `, so a failed match at one position is O(1), not O(n).
 */
const RUN_TEXT = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>/g;

/**
 * The words of a DOCX body, one paragraph per line: `word/document.xml`'s `w:t` runs, split on
 * `</w:p>`. Returns null once `deadline` (epoch ms) passes -- a backstop against a paragraph shape
 * this file didn't anticipate (B4): even a linear-time regex over a large-enough or repeatedly
 * pathological document could still run past what a person would wait for, and JS has no way to
 * preempt a synchronous regex mid-match, so the check runs only *between* paragraphs. Real documents
 * (including every fixture here) finish in single-digit milliseconds, well inside any budget.
 */
function bodyTextFromDocumentXml(xml: string, deadline: number): string | null {
  const lines: string[] = [];
  for (const paragraph of xml.split(/<\/w:p>/)) {
    if (Date.now() > deadline) return null;
    const line = [...paragraph.matchAll(RUN_TEXT)].map((match) => decodeXmlEntities(match[1]!)).join("");
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Gate fix round 1, B3 (a DOCX zip bomb): a DOCX is a zip like any other, so it needs the same guard
 * `archive-text.ts` already applies to CSV/TXT/MD/JSON entries -- entry count, per-entry uncompressed
 * size and compression ratio, all read from the zip's own declared header metadata *before* fflate
 * inflates anything. Without it, a few-hundred-KB DOCX could inflate to hundreds of megabytes (the
 * reviewer's probe: a 205 KB DOCX saved 200 MB of "extracted text"), or past Node's own maximum string
 * length (a 614 KB DOCX inflating to 600 MB threw uncaught, an internal 500 -- breaking this module's
 * own "never throws" contract). The numbers match archive-text.ts's own defaults exactly, so the same
 * document doesn't get a more permissive guard just because it arrived as a DOCX instead of a ZIP.
 */
const DEFAULT_MAX_DOCX_ENTRIES = 500;
const DEFAULT_MAX_DOCX_RATIO = 100;
const DEFAULT_MAX_DOCX_XML_BYTES = 2 * 1024 * 1024;

class DocxCapError extends Error {
  readonly reason: "zip_bomb";
  constructor(message: string) {
    super(message);
    this.reason = "zip_bomb";
  }
}

function docxText(data: Uint8Array, timeoutMs: number): DocumentTextResult {
  if (looksLikeEncryptedOoxml(data)) {
    return { ok: false, reason: "encrypted", message: "That DOCX is password-protected. Remove the password and upload it again." };
  }
  let seen = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter(file) {
        seen += 1;
        if (seen > DEFAULT_MAX_DOCX_ENTRIES) throw new DocxCapError(`That DOCX has more than ${DEFAULT_MAX_DOCX_ENTRIES} entries.`);
        if (file.name !== "word/document.xml") return false;
        if (file.size > 0 && file.originalSize / file.size > DEFAULT_MAX_DOCX_RATIO) {
          throw new DocxCapError("That DOCX decompresses far beyond its stored size (a zip-bomb guard).");
        }
        if (file.originalSize > DEFAULT_MAX_DOCX_XML_BYTES) {
          throw new DocxCapError(`That DOCX's document text is larger than ${Math.round(DEFAULT_MAX_DOCX_XML_BYTES / (1024 * 1024))} MB uncompressed.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DocxCapError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: "malformed", message: "That DOCX can't be read. It may be damaged, or not really a DOCX." };
  }
  const part = entries["word/document.xml"];
  if (!part) return { ok: false, reason: "malformed", message: "That DOCX can't be read. It may be damaged, or not really a DOCX." };
  const body = bodyTextFromDocumentXml(strFromU8(part), Date.now() + timeoutMs);
  if (body === null) return { ok: false, reason: "timeout", message: `That DOCX took longer than ${Math.round(timeoutMs / 1000)} s to read. Try a smaller file.` };
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: "empty", message: "That DOCX has no extractable text." };
  return { ok: true, text: trimmed };
}

/** Extracts the text of a PDF or DOCX file, already read into memory. Never throws. */
export async function extractDocumentText(kind: DocumentKind, data: Uint8Array, options: DocumentTextOptions = {}): Promise<DocumentTextResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (data.byteLength > maxBytes) {
    return { ok: false, reason: "too_large", message: `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.` };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (kind === "pdf") return pdfText(data, timeoutMs);
  return docxText(data, timeoutMs);
}
