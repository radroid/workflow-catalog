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
 * `safeFetch(url)`. It never throws: every outcome is a `SafeFetchResult`.
 * Everything else is an injectable seam, so tests exercise every check (the
 * scheme gate, address blocking, redirect re-validation, the size cap, the
 * deadline and the content-type gate) against local fake servers, never the
 * real network:
 *
 * - `resolve`: DNS lookup, replaced in tests with a fake that maps a
 *   fictional hostname to whatever address the scenario needs (including a
 *   blocked one, to prove a hostile DNS answer is caught).
 * - `performRequest`: the one function that opens a connection. It is handed
 *   the address `safeFetch` just checked and must connect there, never
 *   re-resolving the URL's hostname (the DNS-rebinding gap a second,
 *   independent lookup inside a generic `fetch()` would leave open). The
 *   production default, `nodeHttpsRequest`, pins `node:https`'s `lookup` to
 *   that address; for an IP-literal host Node never calls `lookup` and
 *   connects to the literal itself, which is the address that was checked.
 *
 * Every check runs again on every redirect hop: a redirect to a blocked
 * address is refused exactly like a first request to one would be.
 *
 * One deadline (round-2 review T4). `safeFetch` makes one `AbortSignal` for
 * the whole call and hands it to the transport. DNS, every hop's request and
 * every body read race that signal, so a transport or resolver that ignores
 * it still cannot outlive the deadline. A failure is classified by its
 * cause, never by the shape of the error the transport happened to throw:
 * the real transport reports both "our deadline destroyed the socket" and
 * "the server reset the connection" as the same `ECONNRESET` "aborted" error
 * mid-body (reviewer probe, round 2), so the question asked is whether the
 * deadline signal has fired:
 *   - the deadline fired: `timeout`;
 *   - any other error or abort (a reset, a refused connection): `request_failed`;
 *   - more bytes than `maxBytes`: `too_large`, and only that.
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
  /** Raw response body chunks; safeFetch enforces the size cap and the deadline while consuming this, so a transport never has to. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Ends the underlying connection without reading the rest of the body (a redirect's, a refused page's, or a body read that has been abandoned). Always safe to call more than once. */
  readonly cancel: () => void;
}

/**
 * Injectable transport: issues exactly one request (no redirect following)
 * to `address`, never re-resolving `url.hostname` itself. `signal` is
 * `safeFetch`'s one overall deadline: a transport should abort on it, and
 * `safeFetch` stops waiting on it either way.
 */
export type PerformRequest = (input: { readonly url: URL; readonly address: string; readonly signal: AbortSignal }) => Promise<SafeFetchResponse>;

export interface SafeFetchOptions {
  readonly resolve?: Resolve;
  readonly performRequest?: PerformRequest;
  /** Default 5: generous for a job board's tracking redirect chain, bounded against a redirect loop. */
  readonly maxRedirects?: number;
  /** Default 2 MiB: room for a real HTML page; the extracted text is capped separately at 200 KB (P04 packet). */
  readonly maxBytes?: number;
  /** Default 10 s. One deadline for the whole call: DNS, every redirect hop and every body read together. */
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

// --- Address rules -----------------------------------------------------------

/** Strips a URL host's `[...]` brackets (WHATWG URL always brackets an IPv6 host); a no-op for anything else. */
function bareHostname(hostname: string): string {
  return hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Parses any valid textual IPv6 address (compressed `::`, zero-padded,
 * uncompressed, an embedded dotted-IPv4 tail, or a zone id) into its 16 raw
 * bytes. `undefined` for anything that doesn't parse, which the only caller
 * treats as "not safe".
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
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
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

/** IPv6 ranges blocked outright, whatever they embed. `net.BlockList` compares numerically, so every textual form of one address agrees. */
const IPV6_BLOCKED_RANGES = new net.BlockList();
IPV6_BLOCKED_RANGES.addAddress("::", "ipv6"); // unspecified
IPV6_BLOCKED_RANGES.addAddress("::1", "ipv6"); // loopback
IPV6_BLOCKED_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local
IPV6_BLOCKED_RANGES.addSubnet("fec0::", 10, "ipv6"); // site-local (deprecated)
IPV6_BLOCKED_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique local
IPV6_BLOCKED_RANGES.addSubnet("ff00::", 8, "ipv6"); // multicast
IPV6_BLOCKED_RANGES.addSubnet("64:ff9b:1::", 48, "ipv6"); // T7: local-use NAT64 (RFC 8215), a translator on the person's own network
IPV6_BLOCKED_RANGES.addSubnet("2002::", 16, "ipv6"); // T7: 6to4, which tunnels to an IPv4 address it encodes

/**
 * IPv6 ranges that carry an IPv4 address in their last 32 bits, which
 * decides (round-1 L2: "each checked by its embedded IPv4"): IPv4-mapped
 * `::ffff:0:0/96`, IPv4-translated `::ffff:0:0:0/96` (T7), IPv4-compatible
 * `::/96` and NAT64 `64:ff9b::/96`.
 */
const EMBEDDED_IPV4_RANGES = new net.BlockList();
EMBEDDED_IPV4_RANGES.addSubnet("::ffff:0:0", 96, "ipv6");
EMBEDDED_IPV4_RANGES.addSubnet("::ffff:0:0:0", 96, "ipv6");
EMBEDDED_IPV4_RANGES.addSubnet("::", 96, "ipv6");
EMBEDDED_IPV4_RANGES.addSubnet("64:ff9b::", 96, "ipv6");

function isBlockedIPv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true; // unparseable: never safe to connect to.
  const canonical = bytesToCanonicalIPv6(bytes);
  if (IPV6_BLOCKED_RANGES.check(canonical, "ipv6")) return true;
  if (EMBEDDED_IPV4_RANGES.check(canonical, "ipv6")) return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  return false;
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8: "this network" / unspecified
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, including the 169.254.169.254 metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598): shared address space
  if (a === 198 && (b === 18 || b === 19)) return true; // T7: 198.18.0.0/15, benchmarking (RFC 2544), not publicly routed
  if (a === 192 && b === 0 && c === 0) return true; // T7: 192.0.0.0/24, IETF protocol assignments (RFC 6890)
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4)
  return false;
}

/**
 * True for a loopback, private, link-local (including the cloud metadata
 * address `169.254.169.254`), or otherwise non-public address, IPv4 or IPv6,
 * including every IPv6 form that embeds or tunnels to such an IPv4 address.
 * `address` is always a bare literal (never bracketed); anything that is not
 * a literal IP at all is blocked, since it can't be connected to directly.
 */
export function isBlockedAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) return isBlockedIPv4(address);
  if (kind === 6) return isBlockedIPv6(address);
  return true;
}

// --- The deadline --------------------------------------------------------------

const ABORTED = Symbol("aborted");

/** Settles with `promise`'s value, or `ABORTED` as soon as `signal` fires, whichever is first. A later rejection of `promise` is handled here, so it never goes unhandled. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// --- The production transport ------------------------------------------------

const nodeResolve: Resolve = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

/**
 * Production transport: connects to the checked `address`, never re-resolving
 * `url.hostname`. The pinned `lookup` answers whichever shape Node asks for:
 * with `{ all: true }` (Node 24's `autoSelectFamily` default) an array of
 * candidates, otherwise the classic `(error, address, family)` triple. For an
 * IP-literal host Node skips `lookup` and connects to the literal, which is
 * the address `safeFetch` checked. Exported for `safe-fetch.test.ts`, which
 * drives it against a local TLS server.
 */
export const nodeHttpsRequest: PerformRequest = ({ url, address, signal }) =>
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
        headers: {
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity", // a body we can't decode is a body we can't cap correctly either
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

// --- safeFetch -------------------------------------------------------------------

function contentTypeOf(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The `charset` parameter of a Content-Type header, lowercased, if it has one. */
function declaredCharsetOf(headers: Headers): string | undefined {
  const raw = headers.get("content-type") ?? "";
  const match = /;\s*charset=("?)([^";]+)\1/i.exec(raw);
  return match?.[2]?.trim().toLowerCase();
}

/** A response declaring anything other than identity encoding: `safeFetch` asked for `accept-encoding: identity`, so a server answering otherwise sends a body this can't read correctly. */
function hasUnsupportedEncoding(headers: Headers): boolean {
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  return encoding !== "" && encoding !== "identity";
}

type BodyRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: "too_large" | "timeout" | "request_failed" };

/**
 * Consumes `response.body` up to `maxBytes`, decoding with `charset` when
 * `TextDecoder` supports it, else UTF-8. Never throws. Each chunk read races
 * the deadline, so a body that neither ends nor errors still stops at the
 * deadline. The result is classified by cause (T4): the byte cap is
 * `too_large`; a read that fails or stops once the deadline has fired is
 * `timeout`; any other failure (a reset, an abort from elsewhere) is
 * `request_failed`. An abandoned body is cancelled.
 */
async function readBounded(response: SafeFetchResponse, maxBytes: number, charset: string | undefined, signal: AbortSignal): Promise<BodyRead> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  /** Stops reading: closes this iterator (which releases a web stream's lock and cancels it) and the connection. */
  const abandon = () => {
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // An iterator whose return() throws synchronously has nothing left to close.
    }
    response.cancel();
  };
  try {
    for (;;) {
      const next = await raceAbort(iterator.next(), signal);
      if (next === ABORTED) {
        abandon();
        return { ok: false, reason: "timeout" };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        abandon();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    abandon();
    return { ok: false, reason: signal.aborted ? "timeout" : "request_failed" };
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return { ok: true, text: new TextDecoder(charset).decode(buffer) };
    } catch {
      // Not a charset TextDecoder supports: fall through to UTF-8, the same as no declared charset.
    }
  }
  return { ok: true, text: buffer.toString("utf8") };
}

/**
 * Fetches `rawUrl`: https only; no loopback, private, link-local or metadata
 * address, checked after DNS resolution and again on every redirect; a
 * redirect limit; a size cap; one deadline covering DNS, every hop and the
 * body; only `text/html` or `text/plain`, uncompressed. Never throws.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const resolve = options.resolve ?? nodeResolve;
  const performRequest = options.performRequest ?? nodeHttpsRequest;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const timedOut = (): SafeFetchResult => ({ ok: false, reason: "timeout", message: `The page didn't finish loading within ${Math.round(timeoutMs / 1000)} s.` });

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
    if (deadline.aborted) return timedOut();

    const bare = bareHostname(current.hostname);
    const literal = net.isIP(bare);
    let addresses: readonly ResolvedAddress[];
    if (literal) {
      addresses = [{ address: bare, family: literal as 4 | 6 }];
    } else {
      let answer: readonly ResolvedAddress[] | typeof ABORTED;
      try {
        answer = await raceAbort(resolve(current.hostname), deadline);
      } catch {
        return { ok: false, reason: "dns_failed", message: `Could not resolve ${current.hostname}.` };
      }
      if (answer === ABORTED) return timedOut();
      addresses = answer;
    }
    if (addresses.length === 0) return { ok: false, reason: "dns_failed", message: `Could not resolve ${current.hostname}.` };
    if (addresses.some((candidate) => isBlockedAddress(candidate.address))) {
      return { ok: false, reason: "blocked_address", message: "That address is not a public host the runner will fetch (loopback, private, link-local or metadata addresses are refused)." };
    }
    const checkedAddress = addresses[0]!.address;

    const pending = performRequest({ url: current, address: checkedAddress, signal: deadline });
    let response: SafeFetchResponse | typeof ABORTED;
    try {
      response = await raceAbort(pending, deadline);
    } catch (error) {
      if (deadline.aborted) return timedOut();
      return { ok: false, reason: "request_failed", message: `Could not fetch that page: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (response === ABORTED) {
      // A transport that ignored the signal may still answer later: close whatever it brings.
      pending.then(
        (late) => late.cancel(),
        () => undefined,
      );
      return timedOut();
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      // A redirect's body is never the content wanted, and a slow server must not hold the connection open by trickling it.
      response.cancel();
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "redirect_missing_location", message: "The server redirected without saying where to." };
      if (redirects >= maxRedirects) return { ok: false, reason: "too_many_redirects", message: `Too many redirects (over ${maxRedirects}).` };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: "invalid_url", message: "The redirect target is not a valid URL." };
      }
      continue; // the next pass re-checks the scheme, resolves again, and re-checks the address
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

    const read = await readBounded(response, maxBytes, declaredCharsetOf(response.headers), deadline);
    if (!read.ok) {
      if (read.reason === "timeout") return timedOut();
      if (read.reason === "too_large") return { ok: false, reason: "too_large", message: `That page is larger than ${Math.round(maxBytes / 1024)} KB.` };
      return { ok: false, reason: "request_failed", message: "The connection closed before the page finished loading." };
    }
    return { ok: true, status: response.status, contentType, text: read.text, finalUrl: current.toString() };
  }
}
