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

const TITLE_MAX_CHARS = 60;
const TITLE_MAX_WORDS = 6;

/**
 * A job title as a download names it (P06, carried from P05's review): one that reads as a plain name whole
 * (`plainCompanyName`, the greeting's rule, applied to every stretch of at most 6 words and 60 characters, so
 * no word anywhere in it reads as an instruction), cut at a word to its first such stretch. A title longer than
 * that used to be left out, so two long titles at one company downloaded under the same name.
 */
export function plainTitle(title: string | undefined): string | undefined {
  const words = (title ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return undefined;
  const stretches: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const next = [...current, word];
    if (current.length > 0 && (next.length > TITLE_MAX_WORDS || next.join(" ").length > TITLE_MAX_CHARS)) {
      stretches.push(current.join(" "));
      current = [word];
    } else {
      current = next;
    }
  }
  stretches.push(current.join(" "));
  if (!stretches.every((stretch) => plainCompanyName(stretch) === stretch)) return undefined;
  // A cut never ends the name on a joining word's punctuation ("Platform Lead -").
  return stretches[0]!.replace(/[\s&.,'’-]+$/u, "") || undefined;
}

/** The job as a download names it: "Fernwood Platform Lead", from whichever of the company and title read as plain names. */
export function jobFilePart(job: Pick<JobStructured, "company" | "title"> | undefined): string {
  const company = plainCompanyName(job?.company);
  const title = plainTitle(job?.title);
  return fileNamePart([company, title].filter(Boolean).join(" "));
}

export interface JobNameSource {
  readonly jobId: string;
  /** `jobFilePart` of the job as the downloads name it. */
  readonly part: string;
  /** When the job was first captured: the order two jobs that share a name are numbered in, which never changes. */
  readonly firstCapturedAt: string;
}

/**
 * Tells apart jobs whose downloads would share a name (P06): the second job, by first capture, with the same
 * company and title part is numbered 2, the third 3, and so on; the first keeps the plain name. Case is ignored,
 * as file systems that ignore it would.
 */
export function jobNameOrdinals(jobs: readonly JobNameSource[]): Map<string, number> {
  const groups = new Map<string, JobNameSource[]>();
  for (const job of jobs) {
    const key = job.part.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const ordinals = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.firstCapturedAt.localeCompare(b.firstCapturedAt) || a.jobId.localeCompare(b.jobId));
    ordered.forEach((job, index) => ordinals.set(job.jobId, index + 1));
  }
  return ordinals;
}

export interface DownloadNameInput {
  /** The name on the document. */
  readonly person: string | undefined;
  readonly kind: ApplicationDocument["kind"];
  readonly format: ApplicationDocument["format"];
  readonly version: number;
  readonly job: Pick<JobStructured, "company" | "title"> | undefined;
  /** The job's number among jobs whose downloads share its name (`jobNameOrdinals`); 1 or absent for the first. */
  readonly jobOrdinal?: number;
}

/**
 * "Ada Quill - Resume - Fernwood Platform Lead.pdf"; "Ada Quill - Cover letter - Fernwood Platform Lead.docx";
 * "Ada Quill - What changed in version 2 - Fernwood Platform Lead.md". A part that's empty is left out.
 */
export function downloadName(input: DownloadNameInput): string {
  const kind = input.kind === "diff" ? `${KIND_WORDS.diff} in version ${input.version}` : KIND_WORDS[input.kind];
  const job = jobFilePart(input.job);
  const ordinal = input.jobOrdinal !== undefined && input.jobOrdinal > 1 ? input.jobOrdinal : undefined;
  // The number that tells two same-named jobs apart goes last, after any cut for length, so a cut never drops it.
  const suffix = ordinal === undefined ? "" : job ? ` (${ordinal})` : ` - Job ${ordinal}`;
  const parts = [fileNamePart(input.person ?? ""), kind, job].filter((part) => part.length > 0);
  let base = parts.join(" - ");
  const room = MAX_BASE_LENGTH - suffix.length;
  const chars = Array.from(base);
  if (chars.length > room) base = fileNamePart(chars.slice(0, room).join(""));
  return `${base}${suffix}.${input.format}`;
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
