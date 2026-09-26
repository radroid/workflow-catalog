import { createHash } from "node:crypto";

/**
 * The release tarball is verified against its `.sha256` asset before
 * anything is unpacked (P10 packet, "Decisions already made"). The `.sha256`
 * file is exactly `sha256sum`'s output
 * (`.github/workflows/release-package.yml`, "Rename the tarball..."):
 * `<hex>␣␣<filename>\n`. This module only computes and compares digests; it
 * never fetches anything (see `release-source.ts`).
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ParsedChecksumFile {
  readonly hex: string;
  readonly filename: string;
}

/** Parses one `sha256sum`-format line. Undefined for anything else (a mismatch is then reported as `checksum_mismatch`, not a parse crash). */
export function parseChecksumFile(text: string): ParsedChecksumFile | undefined {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  if (!line) return undefined;
  const match = /^([0-9a-fA-F]{64})\s+[* ]?(\S.*)$/.exec(line.trim());
  if (!match) return undefined;
  const [, hex, filename] = match;
  return { hex: hex!.toLowerCase(), filename: filename! };
}

export interface ChecksumCheck {
  readonly ok: boolean;
  /** Set when the .sha256 asset itself could not be parsed (still refuses; never a parse crash). */
  readonly parseError?: string;
}

/** Verifies `tarballBytes` against a `.sha256` asset's contents. Constant-length hex compare is not needed here: both values are public (the release is published), so timing leaks nothing secret. */
export function verifyChecksum(tarballBytes: Uint8Array, checksumFileText: string): ChecksumCheck {
  const parsed = parseChecksumFile(checksumFileText);
  if (!parsed) return { ok: false, parseError: "The .sha256 file is not in the expected `<hex>  <filename>` form." };
  return { ok: sha256Hex(tarballBytes) === parsed.hex };
}
