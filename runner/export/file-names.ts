import type { ApplicationDocument, JobStructured } from "@workflow-catalog/contracts";
import { plainCompanyName } from "./document.ts";

/**
 * The name a document downloads under (revision 1, V14): "Ada Quill - Resume -
 * Fernwood Platform Lead.pdf", the same in the page's `download` attribute and
 * in the response's `Content-Disposition`. The workspace keeps its own file
 * names (`resume-v2.pdf`); only the download is named for the person and the
 * job.
 *
 * The job part is the posting's company and title only when each reads as a
 * plain name (`plainCompanyName`, the greeting's rule): posting text never
 * becomes more of a file name than that. Every part is made safe for
 * Windows, macOS and Linux file systems: no path separators, no characters
 * Windows reserves, no control or invisible characters, no leading dot, no
 * trailing dot or space, and a bounded length.
 */

const KIND_WORDS: Readonly<Record<ApplicationDocument["kind"], string>> = { resume: "Resume", cover_letter: "Cover letter", diff: "What changed" };
const MAX_BASE_LENGTH = 120;

/** `text` with nothing a file system refuses or hides: one line, no separators or reserved characters, trimmed. */
export function fileNamePart(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
}

/** The job as a download names it: "Fernwood Platform Lead", from whichever of the company and title read as plain names. */
export function jobFilePart(job: Pick<JobStructured, "company" | "title"> | undefined): string {
  const company = plainCompanyName(job?.company);
  const title = plainCompanyName(job?.title);
  return fileNamePart([company, title].filter(Boolean).join(" "));
}

export interface DownloadNameInput {
  /** The name on the document. */
  readonly person: string | undefined;
  readonly kind: ApplicationDocument["kind"];
  readonly format: ApplicationDocument["format"];
  readonly version: number;
  readonly job: Pick<JobStructured, "company" | "title"> | undefined;
}

/**
 * "Ada Quill - Resume - Fernwood Platform Lead.pdf"; "Ada Quill - Cover letter - Fernwood Platform Lead.docx";
 * "Ada Quill - What changed in version 2 - Fernwood Platform Lead.md". A part that's empty is left out.
 */
export function downloadName(input: DownloadNameInput): string {
  const kind = input.kind === "diff" ? `${KIND_WORDS.diff} in version ${input.version}` : KIND_WORDS[input.kind];
  const parts = [fileNamePart(input.person ?? ""), kind, jobFilePart(input.job)].filter((part) => part.length > 0);
  let base = parts.join(" - ");
  const chars = Array.from(base);
  if (chars.length > MAX_BASE_LENGTH) base = fileNamePart(chars.slice(0, MAX_BASE_LENGTH).join(""));
  return `${base}.${input.format}`;
}

/** The same name in plain ASCII, for `filename=`: accents dropped, anything else outside ASCII as "_". */
export function asciiFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
}

/** `attachment; filename="…"`, plus RFC 6266's `filename*=UTF-8''…` when the name isn't plain ASCII. */
export function contentDisposition(name: string): string {
  const ascii = asciiFileName(name);
  if (ascii === name) return `attachment; filename="${name}"`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
