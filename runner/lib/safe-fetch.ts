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
 *
 * Round-1 review fixes (logs/handoff/P04-round-1-review.md, decisions L1,
 * L2, L4, L8):
 * - L1: Node 24's `autoSelectFamily` calls the pinned `lookup` with
 *   `{ all: true }` and expects an array back; the old callback answered the
 *   3-argument shape unconditionally, so every real fetch threw
 *   `ERR_INVALID_IP_ADDRESS` and no test ever drove the production
 *   transport to notice. `nodeHttpsRequest`'s `lookup` now answers whichever
 *   shape it was asked for, and `safe-fetch.test.ts` drives the real
 *   transport end to end against a local server.
 * - L2: a bracketed IPv6 URL host (`https://[::1]/`) never reaches
 *   `net.isIP` as a literal (brackets make it fail), so it went to `resolve`
 *   as if it were a hostname — and confirmed separately, Node's
 *   `https.request` never calls a custom `lookup` at all for a literal IPv6
 *   host, so the address `safeFetch` validated and the address the socket
 *   actually connects to were two different things. Fixed by stripping
 *   brackets before the literal check, so an IPv6 URL host is recognized and
 *   validated as the literal it is, the same as an IPv4 literal already was.
 *   `isBlockedIPv6` is rewritten against parsed 16-byte addresses and
 *   `net.BlockList` (numeric containment, immune to hex/decimal/compressed/
 *   zero-padded textual differences) instead of string-prefix matching,
 *   which missed most of the IPv6 table below.
 * - L4: `safeFetch` claimed "never throws" but didn't guard the body reads
 *   (`readBounded`, and the three former `drainBody` call sites) — a
 *   slow-drip body destroyed by the timeout signal threw out of the `for
 *   await` loop, uncaught. Every body read is now wrapped, one overall
 *   deadline (not a fresh one per redirect hop, and not DNS-exempt) covers
 *   resolution, every hop's connection and the body, a redirect's body is
 *   cancelled outright rather than drained, `accept-encoding: identity` is
 *   sent and any other `content-encoding` is refused, and a declared
 *   charset `TextDecoder` supports is honoured (falling back to UTF-8).
 * - L8/M8: the size cap already checked incrementally inside the read loop,
 *   but nothing timed it — a body that never ends could hang instead of
 *   resolving `too_large` promptly. The one overall deadline fixes this too:
 *   an endless body now aborts (and is read as `too_large` well before
 *   `maxBytes`, if it gets that far, or `timeout` if the deadline is
 *   shorter) instead of hanging.
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
  /** Ends the underlying connection without reading the rest of the body (L4: a redirect's, a non-2xx's, or a wrong-content-type's body is never content safeFetch wants, and a hostile or slow server must not be able to hold the connection open by trickling it). Always safe to call more than once. */
  readonly cancel: () => void;
}

/** Injectable transport: issues exactly one request (no redirect following) and connects to `address`, never re-resolving `url.hostname` itself. `timeoutMs` is this call's *share* of `safeFetch`'s one overall deadline, not a fresh budget of its own. */
export type PerformRequest = (input: { readonly url: URL; readonly address: string; readonly timeoutMs: number }) => Promise<SafeFetchResponse>;

export interface SafeFetchOptions {
  readonly resolve?: Resolve;
  readonly performRequest?: PerformRequest;
  /** Default 5: generous for a job board's tracking redirect chain, bounded against a redirect loop. */
  readonly maxRedirects?: number;
  /** Default 2 MiB: room for a real HTML page; the extracted text is capped separately at 200 KB (P04 packet). */
  readonly maxBytes?: number;
  /** Default 10 s. One deadline for the whole call — DNS, every redirect hop's connection, and every body read together, not a fresh allowance for each. */
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

// --- IPv6 parsing (L2) -------------------------------------------------------

/** Strips a URL host's `[...]` brackets (WHATWG URL always brackets an IPv6 host); a no-op for anything else. */
function bareHostname(hostname: string): string {
  return hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Parses any valid textual IPv6 address (compressed `::`, zero-padded,
 * uncompressed, an embedded dotted-IPv4 tail, or a zone id) into its 16 raw
 * bytes. `undefined` for anything that doesn't parse — callers must treat
 * that as "not safe", never as "not IPv6, try something else", since the
 * only caller (`isBlockedIPv6`) is reached exactly when `net.isIP` already
 * said "6".
 */
function ipv6ToBytes(address: string): Uint8Array | undefined {
  const withoutZone = address.split("%")[0] ?? address;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined; // "::" may appear at most once

  function parseGroups(part: string): number[] | undefined {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (piece === undefined) return undefined;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const octets = piece.split(".");
        if (octets.length !== 4) return undefined;
        const numbers = octets.map(Number);
        if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
        groups.push((numbers[0]! << 8) | numbers[1]!, (numbers[2]! << 8) | numbers[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  }

  let groups: number[] | undefined;
  if (halves.length === 2) {
    const head = parseGroups(halves[0]!);
    const tail = parseGroups(halves[1]!);
    if (!head || !tail) return undefined;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return undefined;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    groups = parseGroups(withoutZone);
  }
  if (!groups || groups.length !== 8 || groups.some((value) => value < 0 || value > 0xffff)) return undefined;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function bytesToCanonicalIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  return groups.join(":");
}

/** Ranges blocked outright, regardless of what (if anything) they embed. Built once; `net.BlockList` compares numerically, so every textual form of the same address agrees. */
const IPV6_BLOCKED_RANGES = new net.BlockList();
IPV6_BLOCKED_RANGES.addAddress("::", "ipv6"); // unspecified
IPV6_BLOCKED_RANGES.addAddress("::1", "ipv6"); // loopback
IPV6_BLOCKED_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local
IPV6_BLOCKED_RANGES.addSubnet("fec0::", 10, "ipv6"); // site-local (deprecated)
IPV6_BLOCKED_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique local
IPV6_BLOCKED_RANGES.addSubnet("ff00::", 8, "ipv6"); // multicast

/** Ranges whose *embedded IPv4* decides it, not the range itself (L2: "each checked by its embedded IPv4") — an IPv4-mapped/compatible/NAT64 address that embeds a public IPv4 address is public. */
const IPV4_MAPPED_RANGE = new net.BlockList();
IPV4_MAPPED_RANGE.addSubnet("::ffff:0:0", 96, "ipv6");
const IPV4_COMPATIBLE_RANGE = new net.BlockList();
IPV4_COMPATIBLE_RANGE.addSubnet("::", 96, "ipv6");
const NAT64_RANGE = new net.BlockList();
NAT64_RANGE.addSubnet("64:ff9b::", 96, "ipv6");

function isBlockedIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true; // unparseable: never safe to connect to.
  const canonical = bytesToCanonicalIPv6(bytes);
  if (IPV6_BLOCKED_RANGES.check(canonical, "ipv6")) return true;
  if (IPV4_MAPPED_RANGE.check(canonical, "ipv6") || IPV4_COMPATIBLE_RANGE.check(canonical, "ipv6") || NAT64_RANGE.check(canonical, "ipv6")) {
    const embeddedIPv4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isBlockedIPv4(embeddedIPv4);
  }
  return false;
}

/**
 * True for a loopback, RFC 1918 private, link-local (including the cloud
 * metadata address `169.254.169.254`), or otherwise non-public address —
 * IPv4 and IPv6, including every IPv4-mapped/compatible/NAT64 IPv6 form.
 * Exported and tested directly (every mutation proof for "drop the
 * post-redirect address check" targets a caller of this, never this
 * function's own ranges). `address` is always a bare literal (never
 * bracketed) — callers strip brackets first.
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

const nodeResolve: Resolve = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

/**
 * Production transport: connects to the validated `address`, never
 * re-resolving `url.hostname` (closes the DNS-rebinding TOCTOU gap). L1: the
 * pinned `lookup` must answer whichever shape Node asked for — with
 * `{ all: true }` (Node 24's `autoSelectFamily` default) an array of
 * candidates, otherwise the classic `(error, address, family)` triple.
 * Answering only the triple made every real request throw
 * `ERR_INVALID_IP_ADDRESS`, caught by no test because every existing test
 * substitutes its own `performRequest` and never exercises this function.
 */
/**
 * Exported for `safe-fetch.test.ts` alone: `isBlockedAddress` refuses every
 * address a test could actually bind a local listener to (127.0.0.1, ::1 —
 * the whole point of this file), so a test driving `safeFetch`'s full
 * pipeline can never reach this transport at all. L1's own fix is a property
 * of this function in isolation — given a validated address, does the
 * connection land on it — so it is tested directly, the same way the
 * reviewer's own probe (`lookup-fix-probe.mjs`) did.
 */
export const nodeHttpsRequest: PerformRequest = ({ url, address, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const family = net.isIP(address) === 6 ? 6 : 4;
    const req = httpsRequest(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        lookup: (_hostname, options, callback) => {
          if (options && typeof options === "object" && (options as { all?: boolean }).all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        headers: {
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity", // L4: never ask for compression; a body we can't decode is a body we can't cap correctly either.
          "user-agent": "workflow-catalog-runner/0.1 (+job capture)",
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
        }
        resolve({ status: res.statusCode ?? 0, headers, body: res, cancel: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

function contentTypeOf(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The `charset` parameter of a Content-Type header, lowercased, if it has one. */
function declaredCharsetOf(headers: Headers): string | undefined {
  const raw = headers.get("content-type") ?? "";
  const match = /;\s*charset=("?)([^";]+)\1/i.exec(raw);
  return match?.[2]?.trim().toLowerCase();
}

/** A response declaring anything other than identity encoding: safeFetch asked for `accept-encoding: identity` (L4), so a server that answers with one anyway is either ignoring that or lying about it — either way, not a body this reads correctly. */
function hasUnsupportedEncoding(headers: Headers): boolean {
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  return encoding !== "" && encoding !== "identity";
}

async function resolveAndValidate(hostname: string, resolve: Resolve, remainingMs: number): Promise<{ ok: true; address: string } | { ok: false; result: SafeFetchResult }> {
  const bare = bareHostname(hostname);
  const literal = net.isIP(bare);
  let addresses: readonly ResolvedAddress[];
  if (literal) {
    addresses = [{ address: bare, family: literal as 4 | 6 }];
  } else {
    try {
      addresses = await withDeadline(resolve(hostname), remainingMs);
    } catch (error) {
      return isDeadlineError(error)
        ? { ok: false, result: { ok: false, reason: "timeout", message: "No answer within the fetch's time limit." } }
        : { ok: false, result: { ok: false, reason: "dns_failed", message: `Could not resolve ${hostname}.` } };
    }
  }
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

/** Rejects with a `TimeoutError` after `remainingMs`, so a step with no timeout of its own (DNS resolution) still respects the one overall deadline (L4). */
function withDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) return Promise.reject(Object.assign(new Error("Deadline already passed."), { name: "TimeoutError" }));
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`No answer within ${Math.round(remainingMs / 1000)} s.`), { name: "TimeoutError" })), remainingMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isDeadlineError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Consumes `body` up to `maxBytes`, decoding with `charset` when `TextDecoder` supports it, else UTF-8. Rejects (without ever building the oversized string) once the cap is passed. Never throws: a stream error (including the deadline destroying it mid-read) resolves `{ ok: false, timedOut }` instead of propagating (L4 — this used to be the one unguarded spot that broke "safeFetch never throws"). */
async function readBounded(body: AsyncIterable<Uint8Array>, maxBytes: number, charset: string | undefined): Promise<{ ok: true; text: string } | { ok: false; timedOut: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maxBytes) return { ok: false, timedOut: false };
      chunks.push(chunk);
    }
  } catch (error) {
    return { ok: false, timedOut: isDeadlineError(error) };
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return { ok: true, text: new TextDecoder(charset).decode(buffer) };
    } catch {
      // Not a charset TextDecoder supports: fall through to UTF-8, same as no declared charset at all.
    }
  }
  return { ok: true, text: buffer.toString("utf8") };
}

/**
 * Fetches `rawUrl`: https only, no loopback/private/link-local/metadata
 * address (checked after DNS resolution and again on every redirect), a
 * redirect limit, a size cap, one overall timeout covering DNS, every
 * redirect hop and the body, and only `text/html` or `text/plain` with no
 * compression. Never throws.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const resolve = options.resolve ?? nodeResolve;
  const performRequest = options.performRequest ?? nodeHttpsRequest;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

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
    if (remaining() <= 0) return { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` };
    const validated = await resolveAndValidate(current.hostname, resolve, remaining());
    if (!validated.ok) return validated.result;

    let response: SafeFetchResponse;
    try {
      if (remaining() <= 0) return { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` };
      response = await performRequest({ url: current, address: validated.address, timeoutMs: remaining() });
    } catch (error) {
      return isDeadlineError(error)
        ? { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` }
        : { ok: false, reason: "request_failed", message: `Could not fetch that page: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      // L4: cancel the redirect's body outright — it is never the content we want, and a hostile or slow server
      // must not be able to hold the connection open by trickling it while we wait to read it out.
      response.cancel();
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
      response.cancel();
      return { ok: false, reason: "http_status", message: `The page answered with an error (HTTP ${response.status}).` };
    }

    if (hasUnsupportedEncoding(response.headers)) {
      response.cancel();
      return { ok: false, reason: "unsupported_content_type", message: "That page uses compression the runner does not decode." };
    }

    const contentType = contentTypeOf(response.headers);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      response.cancel();
      return { ok: false, reason: "unsupported_content_type", message: "That page is not plain text or HTML." };
    }

    const read = await readBounded(response.body, maxBytes, declaredCharsetOf(response.headers));
    if (!read.ok) {
      return read.timedOut
        ? { ok: false, reason: "timeout", message: `No answer within ${Math.round(timeoutMs / 1000)} s.` }
        : { ok: false, reason: "too_large", message: `That page is larger than ${Math.round(maxBytes / 1024)} KB.` };
    }
    return { ok: true, status: response.status, contentType, text: read.text, finalUrl: current.toString() };
  }
}
