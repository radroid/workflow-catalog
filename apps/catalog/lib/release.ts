// Fetches the published package release for the template page. Spec
// P09-catalog-site.md part B / mvp-spec.md F2 (AMENDED): "the checksum is
// the SHA-256 of the release tarball, published by the release workflow
// beside the asset (a file inside the tarball cannot hold the tarball's own
// hash)" — so the checksum shown here is read from the *published .sha256
// asset's content*, not computed or embedded anywhere in the package
// itself. Unauthenticated (public repo, public asset), cached via Next's
// data cache (revalidate hourly), with a timeout — this is the one place
// the catalog talks to an outside service on a visitor's request path.
//
// P09-B revision round (fold-in a): this used to look the release up
// through the GitHub REST API first (GET /releases/tags/<tag>), read its
// assets list, and only then fetch the checksum asset's own
// browser_download_url. Two problems: unauthenticated api.github.com calls
// share a 60/hour budget across Vercel's shared egress IPs, and every
// uncached 404 (i.e. every visitor before the first release exists) burned
// one of those 60 for an answer this app doesn't need an API for — GitHub's
// release-download URLs follow one fixed, documented pattern
// (github.com/<owner>/<repo>/releases/download/<tag>/<asset>), so both the
// checksum URL and the tarball URL can be constructed directly. That also
// means there is no API-supplied URL to validate or trust: both URLs are
// built from this file's own constants and the version string, never taken
// from a response body.

const REPO_OWNER = "radroid";
const REPO_NAME = "workflow-catalog";
const PACKAGE_NAME = "job-assistant";

/** Exported so the timeout path is testable without a real multi-second wait (see tests/release.test.ts). */
export const RELEASE_FETCH_TIMEOUT_MS = 5000;

/** Exported so the page can explain the cadence next to the data it produced. */
export const RELEASE_REVALIDATE_SECONDS = 60 * 60; // hourly

/**
 * A .sha256 file is one short line (64 hex chars + two spaces + a filename,
 * see release-package.yml's `sha256sum` step) — a few hundred bytes is
 * generous. Capped so a misbehaving or malicious response on the other end
 * can't hold this request open streaming an unbounded body; combined with
 * the timeout below (which now covers the body read, not just headers —
 * see readCappedText), this is a second, independent bound on how long or
 * how much a stalled/oversized response can cost.
 */
const CHECKSUM_MAX_BYTES = 4096;

export interface PackageRelease {
  version: string;
  tag: string;
  tarballName: string;
  /** Built from the fixed github.com/.../releases/download/ pattern — never Vercel storage, never API-supplied. */
  tarballUrl: string;
  /** Hex SHA-256, read from the .sha256 asset's content, lowercased. */
  checksum: string;
  checksumAssetUrl: string;
}

export type ReleaseFetchResult =
  | { kind: "found"; release: PackageRelease }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export function releaseTag(version: string): string {
  return `${PACKAGE_NAME}@${version}`;
}

function tarballAssetName(version: string): string {
  return `${PACKAGE_NAME}-${version}.tgz`;
}

/** github.com/<owner>/<repo>/releases/download/<tag>/ — GitHub's own fixed, documented asset-download URL pattern; encodeURIComponent turns the tag's "@" into "%40". */
function releaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(tag)}`;
}

/**
 * First two whitespace-separated tokens of a `sha256sum`-style line
 * (`<hex>  <filename>`): the hex must be 64 hex chars, and — a P09-B
 * revision-round addition — the filename must equal the asset we asked
 * for, so a checksum published for a different file (or a response that
 * merely looks line-shaped) can never be shown as if it matched this one.
 */
function parseChecksumLine(text: string, expectedFilename: string): string | null {
  const [hex, filename] = text.trim().split(/\s+/);
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  if (filename !== expectedFilename) return null;
  return hex.toLowerCase();
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return "Request timed out.";
  }
  return err instanceof Error ? err.message : "Unknown network error.";
}

function concatToText(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Reads a response body as text, capped at `maxBytes`, racing every chunk
 * read against `signal` so a stalled body (headers arrived, bytes never
 * finish) is interrupted by the same abort that governs the request —
 * P09-B revision round: the previous version cleared its timer as soon as
 * `fetch()` itself resolved (i.e. once headers arrived), so a body that
 * stalled after that point hung forever with no timeout protection at all.
 */
async function readCappedText(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const capError = new Error(`Response body exceeded ${maxBytes} bytes.`);
        // P09-B peer review, round 2 (low follow-up #2): releaseLock() in
        // the `finally` below only drops *this function's own reference*
        // to the stream — it does not tell the underlying connection to
        // stop. Without an explicit cancel, a misbehaving or malicious
        // response could keep streaming to a socket nothing reads from
        // again for the rest of its lifetime. cancel() first (best-effort:
        // a stream that is already closed/errored can reject it, which
        // must never mask the real capError below), then let `finally`
        // release the lock as before.
        await reader.cancel(capError).catch(() => {});
        throw capError;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatToText(chunks);
}

/**
 * Fetches `url` and returns its status plus its body text, both read to
 * completion *inside* the timed section — `clearTimeout` only runs once the
 * body read has settled (success, cap exceeded, or abort), not as soon as
 * headers arrive. See readCappedText's comment for why that distinction is
 * the fix, not just cosmetic.
 */
async function timedFetchText(url: string, maxBytes: number): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
    const text = response.body
      ? await readCappedText(response.body, maxBytes, controller.signal)
      : await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up the `job-assistant@<version>` release by fetching its published
 * `.sha256` asset directly from GitHub's fixed release-download URL — no
 * API call, no API-supplied URL. A 404 means no release has been published
 * for this version yet. Never throws — every failure mode (no release yet,
 * an HTTP error, a timeout, a stalled/oversized body, a checksum file that
 * doesn't parse or names the wrong asset) resolves to a `ReleaseFetchResult`
 * the page can render gracefully.
 */
export async function fetchPackageRelease(version: string): Promise<ReleaseFetchResult> {
  const tag = releaseTag(version);
  const tarballName = tarballAssetName(version);
  const checksumName = `${tarballName}.sha256`;
  const downloadBase = releaseDownloadBaseUrl(tag);
  const tarballUrl = `${downloadBase}/${tarballName}`;
  const checksumAssetUrl = `${downloadBase}/${checksumName}`;

  let checksumResponse: { status: number; ok: boolean; text: string };
  try {
    checksumResponse = await timedFetchText(checksumAssetUrl, CHECKSUM_MAX_BYTES);
  } catch (err) {
    return { kind: "error", message: describeFetchError(err) };
  }

  if (checksumResponse.status === 404) {
    return { kind: "not_found" };
  }
  if (!checksumResponse.ok) {
    return { kind: "error", message: `Checksum asset responded with ${checksumResponse.status}.` };
  }

  const checksum = parseChecksumLine(checksumResponse.text, tarballName);
  if (!checksum) {
    return { kind: "error", message: "Checksum asset content was not a recognizable sha256sum line for the expected file." };
  }

  return {
    kind: "found",
    release: { version, tag, tarballName, tarballUrl, checksum, checksumAssetUrl },
  };
}
