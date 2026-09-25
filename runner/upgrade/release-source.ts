import { request as httpsRequest } from "node:https";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { isBlockedAddress } from "../lib/safe-fetch.ts";

/**
 * How `npm run upgrade` learns what release exists and pulls its bytes:
 * GitHub's REST API for "the latest release", then that release's asset
 * URLs — the tarball and its `.sha256` (`.github/workflows/release-package.yml`
 * publishes both beside each other). Same https-only, no-loopback/private/
 * link-local-address posture as `lib/safe-fetch.ts` ("The fetch goes through
 * safe-fetch (https only)", P10 packet Decisions) — `isBlockedAddress` is
 * imported from there, the one piece worth sharing exactly rather than
 * reimplementing, since it is the security-critical part. The rest is its
 * own small transport, not `safeFetch` itself: that function decodes every
 * body as text and only accepts `text/html`/`text/plain`
 * (`ALLOWED_CONTENT_TYPES`), which would corrupt a binary tarball and reject
 * the GitHub API's `application/json` outright.
 *
 * Every call is fully injectable (`UpgradeFetchDeps`), so a test never
 * touches the network, GitHub, or DNS (P10 packet Decisions: "Tests never
 * touch the network, GitHub, ...").
 */
export const RELEASE_OWNER = "radroid";
export const RELEASE_REPO = "workflow-catalog";
export const RELEASE_TAG_PREFIX = "job-assistant@";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // generous for a small package tarball; the person's own data never goes near this path
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type Resolve = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
export type PerformRequest = (input: { readonly url: URL; readonly address: string; readonly signal: AbortSignal; readonly headers: Record<string, string>; readonly maxBytes: number }) => Promise<RawResponse>;

export interface UpgradeFetchDeps {
  readonly resolve?: Resolve;
  readonly performRequest?: PerformRequest;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export type FetchBytesResult =
  | { readonly ok: true; readonly status: number; readonly contentType: string; readonly bytes: Buffer; readonly finalUrl: string }
  | { readonly ok: false; readonly reason: "invalid_url" | "scheme_not_https" | "dns_failed" | "blocked_address" | "too_many_redirects" | "redirect_missing_location" | "http_status" | "too_large" | "timeout" | "request_failed"; readonly message: string };

const nodeResolve: Resolve = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

const nodePerformRequest: PerformRequest = ({ url, address, signal, headers, maxBytes }) =>
  new Promise((resolve, reject) => {
    const family = net.isIP(address) === 6 ? 6 : 4;
    const req = httpsRequest(
      url,
      {
        method: "GET",
        signal,
        lookup: (_hostname, options, callback) => {
          if (options && typeof options === "object" && (options as { all?: boolean }).all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new Error("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") responseHeaders[key] = value;
            else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });

/** https-only, SSRF-checked, redirect-following byte fetch. Never throws. */
export async function fetchBytes(rawUrl: string, headers: Record<string, string>, deps: UpgradeFetchDeps = {}): Promise<FetchBytesResult> {
  const resolve = deps.resolve ?? nodeResolve;
  const performRequest = deps.performRequest ?? nodePerformRequest;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url", message: "That is not a valid URL." };
  }

  for (let redirects = 0; ; redirects += 1) {
    if (current.protocol !== "https:") return { ok: false, reason: "scheme_not_https", message: "The upgrade check only fetches https:// URLs." };
    if (deadline.aborted) return { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` };

    const literal = net.isIP(current.hostname);
    let addresses: readonly ResolvedAddress[];
    if (literal) {
      addresses = [{ address: current.hostname, family: literal as 4 | 6 }];
    } else {
      try {
        addresses = await resolve(current.hostname);
      } catch {
        return { ok: false, reason: "dns_failed", message: `Could not resolve ${current.hostname}.` };
      }
    }
    if (addresses.length === 0) return { ok: false, reason: "dns_failed", message: `Could not resolve ${current.hostname}.` };
    if (addresses.some((candidate) => isBlockedAddress(candidate.address))) {
      return { ok: false, reason: "blocked_address", message: "That address is not a public host the upgrade check will fetch." };
    }

    let response: RawResponse;
    try {
      response = await performRequest({ url: current, address: addresses[0]!.address, signal: deadline, headers, maxBytes });
    } catch (error) {
      if (deadline.aborted) return { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` };
      if (error instanceof Error && error.message === "too_large") return { ok: false, reason: "too_large", message: `The response is larger than ${Math.round(maxBytes / 1024)} KB.` };
      return { ok: false, reason: "request_failed", message: `Could not fetch that URL: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location;
      if (!location) return { ok: false, reason: "redirect_missing_location", message: "The server redirected without saying where to." };
      if (redirects >= maxRedirects) return { ok: false, reason: "too_many_redirects", message: `Too many redirects (over ${maxRedirects}).` };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: "invalid_url", message: "The redirect target is not a valid URL." };
      }
      continue; // re-checks scheme, resolves again, and re-checks the address on the next pass
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: "http_status", message: `The server answered with an error (HTTP ${response.status}).` };
    }
    return { ok: true, status: response.status, contentType: (response.headers["content-type"] ?? "").split(";")[0]!.trim(), bytes: response.body, finalUrl: current.toString() };
  }
}

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}
export interface ReleaseInfo {
  readonly tagName: string;
  readonly version: string;
  /** The release's own notes (GitHub release "body"; release-package.yml writes it from workflow.json's changelog entry for this version). Shown before the changelog staged from the tarball is available. */
  readonly notes: string;
  readonly assets: readonly ReleaseAsset[];
}

const USER_AGENT = "workflow-catalog-runner-upgrade/0.1";

export type LatestReleaseResult = { readonly ok: true; readonly release: ReleaseInfo | undefined } | { readonly ok: false; readonly message: string };

/** GET /repos/{owner}/{repo}/releases/latest. `release: undefined` means the repo has no release yet (GitHub answers 404) — not an error. */
export async function fetchLatestRelease(deps: UpgradeFetchDeps = {}): Promise<LatestReleaseResult> {
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
  const result = await fetchBytes(url, { accept: "application/vnd.github+json", "user-agent": USER_AGENT, "accept-encoding": "identity" }, deps);
  if (!result.ok) {
    if (result.reason === "http_status") return { ok: true, release: undefined }; // covers the 404 "no releases yet" case; any other status is rare enough to fold into the same "nothing to offer" answer
    return { ok: false, message: result.message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.bytes.toString("utf8"));
  } catch {
    return { ok: false, message: "GitHub's release response was not valid JSON." };
  }
  const body = parsed as { tag_name?: unknown; body?: unknown; assets?: unknown };
  if (typeof body.tag_name !== "string" || !body.tag_name.startsWith(RELEASE_TAG_PREFIX)) {
    return { ok: true, release: undefined }; // the latest release exists but isn't a job-assistant release
  }
  const version = body.tag_name.slice(RELEASE_TAG_PREFIX.length);
  const rawAssets = Array.isArray(body.assets) ? body.assets : [];
  const assets: ReleaseAsset[] = [];
  for (const asset of rawAssets) {
    if (asset && typeof asset === "object" && typeof (asset as { name?: unknown }).name === "string" && typeof (asset as { browser_download_url?: unknown }).browser_download_url === "string") {
      assets.push({ name: (asset as { name: string }).name, url: (asset as { browser_download_url: string }).browser_download_url });
    }
  }
  return { ok: true, release: { tagName: body.tag_name, version, notes: typeof body.body === "string" ? body.body : "", assets } };
}

export type DownloadAssetResult = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly message: string };

/** Downloads one release asset (the tarball, or its `.sha256`) by its `browser_download_url`. */
export async function downloadReleaseAsset(url: string, deps: UpgradeFetchDeps = {}): Promise<DownloadAssetResult> {
  const result = await fetchBytes(url, { accept: "application/octet-stream", "user-agent": USER_AGENT, "accept-encoding": "identity" }, deps);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, bytes: result.bytes };
}
