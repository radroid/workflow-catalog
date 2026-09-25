import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";

/**
 * Exported-data archives (P03.1, mvp-spec §4 "LinkedIn and other social:
 * the person's exported data archive, uploaded as a file"). Read entirely in
 * memory with `fflate` (see `document-text.ts` for why fflate); an entry is
 * never unpacked to disk, and an entry's path is never used as a file path —
 * only as a `## <name>` label in the composed text.
 *
 * Zip-bomb guard, in order, all checked from each entry's zip header
 * *before* it is inflated (fflate's `filter` runs first and decides whether
 * to decompress at all):
 *   - entry count: a central directory with more entries than `maxEntries`
 *     refuses the whole archive (bounds how much header-walking a hostile
 *     archive can force, independent of any one entry's size);
 *   - compression ratio: an entry whose declared uncompressed size is more
 *     than `maxCompressionRatio` times its compressed size refuses the whole
 *     archive (the standard zip-bomb signature: a tiny stream that claims a
 *     huge output; the 100:1 default follows the commonly cited zip-bomb
 *     detection threshold);
 *   - per-entry size and running total: an entry, or the running total of
 *     included entries, over its cap refuses the whole archive.
 * Only `.csv`, `.txt`, `.md` and `.json` entries are ever decompressed at
 * all — every other entry (images, a nested archive, LinkedIn's PDF export,
 * `.DS_Store`) is skipped by the filter before fflate inflates a single
 * byte of it, which also means a nested zip is never itself unzipped.
 *
 * A header's declared sizes are the zip file's own claim, not a measurement:
 * a stream crafted to inflate far past what it declares would defeat a
 * header-only guard. Defence in depth: the *actual* decompressed byte count
 * of every included entry is re-checked against the same per-entry and
 * total caps after fflate returns, so a lying header still cannot smuggle
 * more text out of this module than the caps allow (fflate has already done
 * the one-time work of inflating that single entry in memory by then, but
 * the caps still hold for everything downstream — the composed text, and
 * what ever reaches a model).
 */

export type ArchiveTextRejectionReason = "too_large" | "malformed" | "zip_bomb" | "empty";

export type ArchiveTextResult =
  | { readonly ok: true; readonly text: string; readonly entriesIncluded: number }
  | { readonly ok: false; readonly reason: ArchiveTextRejectionReason; readonly message: string };

export interface ArchiveTextOptions {
  /** Default 10 MiB: the raw archive file, before decompression. */
  readonly maxBytes?: number;
  /** Default 500. */
  readonly maxEntries?: number;
  /** Default 2 MiB: one entry's uncompressed size. */
  readonly maxEntryBytes?: number;
  /** Default 8 MiB: the total uncompressed size of every included entry. */
  readonly maxTotalBytes?: number;
  /** Default 100: originalSize / compressedSize above this refuses the archive. */
  readonly maxCompressionRatio?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RATIO = 100;

const TEXT_EXTENSIONS = new Set(["csv", "txt", "md", "json"]);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

class ArchiveCapError extends Error {
  readonly reason: "zip_bomb";
  constructor(message: string) {
    super(message);
    this.reason = "zip_bomb";
  }
}

/** Extracts the CSV/TXT/MD/JSON text of an exported-data archive, already read into memory. Never throws. */
export async function extractArchiveText(data: Uint8Array, options: ArchiveTextOptions = {}): Promise<ArchiveTextResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (data.byteLength > maxBytes) {
    return { ok: false, reason: "too_large", message: `That archive is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.` };
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxRatio = options.maxCompressionRatio ?? DEFAULT_MAX_RATIO;

  let seen = 0;
  let declaredTotal = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter(file: UnzipFileInfo) {
        seen += 1;
        if (seen > maxEntries) throw new ArchiveCapError(`That archive has more than ${maxEntries} entries.`);
        if (file.name.endsWith("/")) return false; // a directory entry, not a file
        if (file.size > 0 && file.originalSize / file.size > maxRatio) {
          throw new ArchiveCapError("That archive decompresses far beyond its stored size (a zip-bomb guard).");
        }
        if (!TEXT_EXTENSIONS.has(extensionOf(file.name))) return false; // not CSV, TXT, MD or JSON
        if (file.originalSize > maxEntryBytes) {
          throw new ArchiveCapError(`An entry in that archive is larger than ${Math.round(maxEntryBytes / (1024 * 1024))} MB uncompressed.`);
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > maxTotalBytes) {
          throw new ArchiveCapError(`That archive's text entries add up to more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB uncompressed.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveCapError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: "malformed", message: "That archive can't be read. It may be damaged, or not really a zip file." };
  }

  // Defence in depth (see the module doc): re-check what fflate actually produced, not just what the
  // header declared, before any of it is composed into text a model could read.
  let actualTotal = 0;
  for (const bytes of Object.values(entries)) {
    if (bytes.byteLength > maxEntryBytes) {
      return { ok: false, reason: "zip_bomb", message: `An entry in that archive is larger than ${Math.round(maxEntryBytes / (1024 * 1024))} MB uncompressed.` };
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > maxTotalBytes) {
      return { ok: false, reason: "zip_bomb", message: `That archive's text entries add up to more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB uncompressed.` };
    }
  }

  const names = Object.keys(entries).sort();
  if (names.length === 0) return { ok: false, reason: "empty", message: "That archive has no CSV, TXT, MD or JSON entries to read." };
  const parts = names.map((name) => `## ${name}\n\n${strFromU8(entries[name]!)}`);
  return { ok: true, text: parts.join("\n\n---\n\n"), entriesIncluded: names.length };
}
