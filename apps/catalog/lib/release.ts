// Fetches the published package release for the template page. Spec
// P09-catalog-site.md part B / mvp-spec.md F2 (AMENDED): "the checksum is
// the SHA-256 of the release tarball, published by the release workflow
// beside the asset (a file inside the tarball cannot hold the tarball's own
// hash)" — so the checksum shown here is read from the *published .sha256
// asset's content*, not computed or embedded anywhere in the package
// itself. Unauthenticated (public repo, public API), cached via Next's data
// cache (revalidate hourly), with a timeout — this is the one place the
// catalog talks to an outside service on a visitor's request path.

const REPO_OWNER = "radroid";
const REPO_NAME = "workflow-catalog";
const PACKAGE_NAME = "job-assistant";

/** Exported so the timeout path is testable without a real multi-second wait (see tests/release.test.ts). */
export const RELEASE_FETCH_TIMEOUT_MS = 5000;

/** Exported so the page can explain the cadence next to the data it produced. */
export const RELEASE_REVALIDATE_SECONDS = 60 * 60; // hourly

export interface PackageRelease {
  version: string;
  tag: string;
  tarballName: string;
  /** The GitHub release asset's own download URL — never Vercel storage. */
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

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReleaseAssetList(value: unknown): value is GitHubReleaseAsset[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.name === "string" && typeof item.browser_download_url === "string")
  );
}

/** First whitespace-separated token of a `sha256sum`-style line (`<hex>  <filename>`), validated as 64 hex chars. */
function parseChecksumLine(text: string): string | null {
  const hex = text.trim().split(/\s+/)[0];
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();
  return null;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return "Request to GitHub timed out.";
  }
  return err instanceof Error ? err.message : "Unknown network error.";
}

async function timedFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up the GitHub release for `job-assistant@<version>` by the public,
 * unauthenticated REST API, and reads the checksum out of the published
 * `.tgz.sha256` asset. Never throws — every failure mode (no release yet,
 * an API error, a timeout, a malformed response, a release missing an
 * expected asset) resolves to a `ReleaseFetchResult` the page can render
 * gracefully.
 */
export async function fetchPackageRelease(version: string): Promise<ReleaseFetchResult> {
  const tag = releaseTag(version);
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${encodeURIComponent(tag)}`;

  let releaseResponse: Response;
  try {
    releaseResponse = await timedFetch(apiUrl);
  } catch (err) {
    return { kind: "error", message: describeFetchError(err) };
  }

  if (releaseResponse.status === 404) {
    return { kind: "not_found" };
  }
  if (!releaseResponse.ok) {
    return { kind: "error", message: `GitHub API responded with ${releaseResponse.status}.` };
  }

  let body: unknown;
  try {
    body = await releaseResponse.json();
  } catch {
    return { kind: "error", message: "GitHub API returned a response that was not valid JSON." };
  }

  const assets = isRecord(body) ? body.assets : undefined;
  if (!isReleaseAssetList(assets)) {
    return { kind: "error", message: "GitHub API response for this release had no readable assets list." };
  }

  const tarballName = tarballAssetName(version);
  const checksumName = `${tarballName}.sha256`;
  const tarballAsset = assets.find((asset) => asset.name === tarballName);
  const checksumAsset = assets.find((asset) => asset.name === checksumName);

  if (!tarballAsset || !checksumAsset) {
    return { kind: "error", message: `Release ${tag} is missing ${tarballName} or ${checksumName}.` };
  }

  let checksumResponse: Response;
  try {
    checksumResponse = await timedFetch(checksumAsset.browser_download_url);
  } catch (err) {
    return { kind: "error", message: describeFetchError(err) };
  }
  if (!checksumResponse.ok) {
    return { kind: "error", message: `Checksum asset responded with ${checksumResponse.status}.` };
  }

  const checksum = parseChecksumLine(await checksumResponse.text());
  if (!checksum) {
    return { kind: "error", message: "Checksum asset content was not a recognizable sha256sum line." };
  }

  return {
    kind: "found",
    release: {
      version,
      tag,
      tarballName,
      tarballUrl: tarballAsset.browser_download_url,
      checksum,
      checksumAssetUrl: checksumAsset.browser_download_url,
    },
  };
}
