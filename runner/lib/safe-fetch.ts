import { request as httpsRequest } from "node:https";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * The URL-fetch path's only way onto the network (P04, mvp-spec F6; the
 * "P04 URL rule" decision in `logs/blocks.md`: only this path is
 * https-only, with every SSRF rule; a captured or pasted URL is provenance
 * and is never fetched at all).
 *
 * Small, documented interface, its own tests (P03.1 reuses it): call
 * `safeFetch(url)`. Everything else is an injectable seam so tests exercise
 * every check — the scheme gate, address blocking, redirect re-validation,
 * the size cap, the timeout and the content-type gate — against a local fake
 * server, never the real network:
 *
 * - `resolve`: DNS lookup, replaced in tests with a fake that maps a
 *   fictional hostname to whatever address the scenario needs (including a
 *   blocked one, to prove a hostile DNS answer is caught).
 * - `performRequest`: the one function that actually opens a connection. The
 *   production default (`nodeHttpsRequest`) uses `node:https` with a custom
 *   `lookup` socket option so the TCP connection lands on exactly the
 *   address `safeFetch` just validated — closing the gap a second,
 *   independent DNS lookup inside a generic `fetch()` would leave open
 *   (classic DNS-rebinding TOCTOU). Tests substitute a fake that talks to a
 *   plain local `http.Server`, so no certificate handling is needed to
 *   exercise the redirect/size/content-type logic in `safeFetch` itself,
 *   which is transport-agnostic.
 *
 * Every check in this file runs again on every redirect hop: a redirect to a
 * blocked address is refused exactly like a first request to one would be
 * (hard-problems.md's SSRF concern applies at every hop, not only the first).
 */

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Injectable DNS resolution. The default asks the OS resolver for every address a hostname has. */
export type Resolve = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeFetchResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Raw response body chunks; safeFetch enforces the size cap while consuming this, so a transport never has to. */
  readonly body: AsyncIterable<Uint8Array>;
}

/** Injectable transport: issues exactly one request (no redirect following) and connects to `address`, never re-resolving `url.hostname` itself. */
export type PerformRequest = (input: { readonly url: URL; readonly address: string; readonly timeoutMs: number }) => Promise<SafeFetchResponse>;

export interface SafeFetchOptions {
  readonly resolve?: Resolve;
  readonly performRequest?: PerformRequest;
  /** Default 5: generous for a job board's tracking redirect chain, bounded against a redirect loop. */
  readonly maxRedirects?: number;
  /** Default 2 MiB: room for a real HTML page; the extracted text is capped separately at 200 KB (P04 packet). */
  readonly maxBytes?: number;
  /** Default 10 s. */
  readonly timeoutMs?: number;
}

export type SafeFetchRejectionReason =
  | "invalid_url"
  | "scheme_not_https"
  | "dns_failed"
  | "blocked_address"
  | "too_many_redirects"
  | "redirect_missing_location"
  | "http_status"
  | "unsupported_content_type"
  | "too_large"
  | "timeout"
  | "request_failed";

export type SafeFetchResult =
  | { readonly ok: true; readonly status: number; readonly contentType: string; readonly text: string; readonly finalUrl: string }
  | { readonly ok: false; readonly reason: SafeFetchRejectionReason; readonly message: string };

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain"]);

/**
 * True for a loopback, RFC 1918 private, link-local (including the cloud
 * metadata address `169.254.169.254`), or otherwise non-public address —
 * IPv4 and IPv6, including an IPv4-mapped IPv6 address. Exported and tested
 * directly (every mutation proof for "drop the post-redirect address check"
 * targets a caller of this, never this function's own ranges).
 */
export function isBlockedAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) return isBlockedIPv4(address);
  if (kind === 6) return isBlockedIPv6(address);
  return true; // not a literal IP at all: never safe to connect to directly.
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8: "this network" / unspecified.
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598) — shared address space, not publicly routable
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4)
  return false;
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  if (normalized === "::" || normalized === "::1") return true; // unspecified / loopback
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (normalized.startsWith("ff")) return true; // multicast
  return false;
}

const nodeResolve: Resolve = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

/** Production transport: connects to the validated `address`, never re-resolving `url.hostname` (closes the DNS-rebinding TOCTOU gap). */
const nodeHttpsRequest: PerformRequest = ({ url, address, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        lookup: (_hostname, _options, callback) => {
          callback(null, address, net.isIP(address) === 6 ? 6 : 4);
        },
        headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": "workflow-catalog-runner/0.1 (+job capture)" },
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
        }
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      },
    );
    req.on("error", reject);
    req.end();
  });

function contentTypeOf(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

async function resolveAndValidate(hostname: string, resolve: Resolve): Promise<{ ok: true; address: string } | { ok: false; result: SafeFetchResult }> {
  const literal = net.isIP(hostname);
  const addresses: readonly ResolvedAddress[] = literal ? [{ address: hostname, family: literal as 4 | 6 }] : await resolve(hostname).catch(() => []);
  if (addresses.length === 0) {
    return { ok: false, result: { ok: false, reason: "dns_failed", message: `Could not resolve ${hostname}.` } };
  }
  const blocked = addresses.find((candidate) => isBlockedAddress(candidate.address));
  if (blocked) {
    return { ok: false, result: { ok: false, reason: "blocked_address", message: "That address is not a public host the runner will fetch (loopback, private, link-local or metadata addresses are refused)." } };
  }
  const first = addresses[0];
  if (!first) return { ok: false, result: { ok: false, reason: "dns_failed", message: `Could not resolve ${hostname}.` } };
  return { ok: true, address: first.address };
}

/** Consumes `body` up to `maxBytes`, decoding as UTF-8. Rejects (without ever building the oversized string) once the cap is passed. */
async function readBounded(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return { ok: false };
    chunks.push(chunk);
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}

/** Fully drains `body` without keeping any of it: used for a redirect, a non-2xx status, or a rejected content type, where the bytes are never the content we want but the stream still has to be consumed. Written with the iterator protocol directly (not `for await (const chunk of body)`) so there is no declared-but-unused loop variable. */
async function drainBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
    // discard step.value
  }
}

/**
 * Fetches `rawUrl`: https only, no loopback/private/link-local/metadata
 * address (checked after DNS resolution and again on every redirect), a
 * redirect limit, a size cap, a timeout, and only `text/html` or
 * `text/plain`. Never throws.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const resolve = options.resolve ?? nodeResolve;
  const performRequest = options.performRequest ?? nodeHttpsRequest;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url", message: "That is not a valid URL." };
  }

  for (let redirects = 0; ; redirects += 1) {
    if (current.protocol !== "https:") {
      return { ok: false, reason: "scheme_not_https", message: "The runner only fetches https:// URLs." };
    }
    const validated = await resolveAndValidate(current.hostname, resolve);
    if (!validated.ok) return validated.result;

    let response: SafeFetchResponse;
    try {
      response = await performRequest({ url: current, address: validated.address, timeoutMs });
    } catch (error) {
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return aborted
        ? { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` }
        : { ok: false, reason: "request_failed", message: `Could not fetch that page: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      // Drain and discard the redirect body; it is never the content we want.
      await drainBody(response.body);
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "redirect_missing_location", message: "The server redirected without saying where to." };
      if (redirects >= maxRedirects) return { ok: false, reason: "too_many_redirects", message: `Too many redirects (over ${maxRedirects}).` };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: "invalid_url", message: "The redirect target is not a valid URL." };
      }
      continue; // loop: the next iteration re-checks scheme, re-resolves DNS, and re-validates the address.
    }

    if (response.status < 200 || response.status >= 300) {
      await drainBody(response.body);
      return { ok: false, reason: "http_status", message: `The page answered with an error (HTTP ${response.status}).` };
    }

    const contentType = contentTypeOf(response.headers);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await drainBody(response.body);
      return { ok: false, reason: "unsupported_content_type", message: "That page is not plain text or HTML." };
    }

    const read = await readBounded(response.body, maxBytes);
    if (!read.ok) return { ok: false, reason: "too_large", message: `That page is larger than ${Math.round(maxBytes / 1024)} KB.` };
    return { ok: true, status: response.status, contentType, text: read.text, finalUrl: current.toString() };
  }
}
