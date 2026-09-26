import { gunzipSync } from "node:zlib";

/**
 * Just enough of gzip+tar to read one file out of a release tarball
 * (`packages/job-assistant/workflow.json`, wrapped under `package/` the way
 * `pnpm pack` — and npm tarballs generally — lay it out), after its checksum
 * has already been verified (`checksum.ts`). No dependency is added
 * (CLAUDE.md/the packet's Owns): gzip is `node:zlib`, a Node built-in, and
 * this file is a plain USTAR/PAX reader, not a general extractor — the
 * upgrade flow never writes a downloaded file to disk (see `upgrade.ts`'s
 * header comment for why), so it never needs directory creation, symlink
 * handling, or a real extraction target, only entry bytes by name.
 *
 * Understands: plain USTAR headers (name, or name+prefix for a path over 100
 * bytes), GNU long-name entries (typeflag "L"), and PAX per-entry extended
 * headers (typeflag "x", the `path`/`size` records only — the ones that can
 * change how an entry is read). A global PAX header ("g") and anything else
 * this doesn't recognise (a symlink, device, fifo) is skipped: harmless for
 * a "find this one file" reader, since skipping never changes which bytes a
 * *different* entry's name resolves to.
 */
const BLOCK_SIZE = 512;

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = Buffer.from(block.slice(offset, offset + length));
  // A GNU "base-256" length starts with 0x80; not produced by pnpm pack's
  // small package tarballs, but a numeric field this large would only ever
  // describe a many-GB entry, well past what the upgrade flow expects
  // anyway, so it is treated as invalid rather than decoded.
  if (raw.length > 0 && (raw[0]! & 0x80) !== 0) throw new Error("Unsupported tar header: a base-256 numeric field.");
  const text = raw.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new Error("Malformed tar header: a numeric field is not valid octal.");
  return value;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const raw = Buffer.from(block.slice(offset, offset + length));
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.slice(0, nul)).toString("utf8");
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** Parses PAX extended-header records: repeated `"<len> <key>=<value>\n"`, length-prefixed including the length field and the trailing newline. */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const text = Buffer.from(data).toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    const spaceIndex = text.indexOf(" ", pos);
    if (spaceIndex === -1) break;
    const declaredLength = Number.parseInt(text.slice(pos, spaceIndex), 10);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) break;
    const record = text.slice(pos, pos + declaredLength);
    const eq = record.indexOf("=", spaceIndex - pos);
    if (eq !== -1) {
      const key = record.slice(spaceIndex - pos + 1, eq);
      const value = record.slice(eq + 1).replace(/\n$/, "");
      records.set(key, value);
    }
    pos += declaredLength;
  }
  return records;
}

export interface TarEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Every regular-file entry in a (non-gzipped) tar archive, in order. Directories, symlinks and other non-file types are skipped, not returned. */
export function readTarEntries(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPax: Map<string, string> | undefined;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break; // the end-of-archive marker (two zero blocks; one is enough to stop here)
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("Truncated tar archive: an entry's declared size runs past the end of the data.");
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    const data = tar.subarray(dataStart, dataEnd);

    if (typeflag === "L") {
      // GNU long-name entry: its body is the *next* header's real name.
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      offset = dataStart + paddedSize;
      continue;
    }
    if (typeflag === "x") {
      pendingPax = parsePaxRecords(data);
      offset = dataStart + paddedSize;
      continue;
    }
    if (typeflag === "g") {
      // A global PAX header applies to every following entry; this reader
      // only ever needs one known file's bytes, and no fixture here sets a
      // global path override, so it is intentionally not merged in.
      offset = dataStart + paddedSize;
      continue;
    }

    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const headerName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = pendingPax?.get("path") ?? pendingLongName ?? headerName;
    const paxSize = pendingPax?.get("size");
    const entrySize = paxSize !== undefined ? Number.parseInt(paxSize, 10) : size;

    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ name, data: entrySize === size ? data : tar.subarray(dataStart, dataStart + entrySize) });
    }
    // typeflag "5" (directory), "2" (symlink), "1" (hardlink) and anything
    // else: skipped. None of them are a file this reader could return bytes
    // for, and skipping them cannot affect a different entry's name or data.

    pendingLongName = undefined;
    pendingPax = undefined;
    offset = dataStart + paddedSize;
  }
  return entries;
}

export class TarballReadError extends Error {
  override readonly name = "TarballReadError";
}

/** Un-gzips, reads every file entry, and returns one by name (an npm/pnpm tarball's entries are named `package/<path>`). `undefined` when gzip fails or the entry is not present — never a thrown parse error for that, since a corrupt or wrong-shaped tarball is exactly what a bad-checksum case already refuses before this ever runs; this is the second, independent guard for "well-formed" beyond "hashes match". */
export function readFileFromReleaseTarball(gzipped: Uint8Array, entryName: string): Uint8Array | undefined {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped);
  } catch (error) {
    throw new TarballReadError(`The release tarball is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
  }
  let entries: TarEntry[];
  try {
    entries = readTarEntries(tar);
  } catch (error) {
    throw new TarballReadError(`The release tarball is not a valid tar archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  return entries.find((entry) => entry.name === entryName || entry.name === `./${entryName}`)?.data;
}
