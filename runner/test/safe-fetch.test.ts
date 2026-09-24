import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isBlockedAddress, nodeHttpsRequest, safeFetch, type PerformRequest, type ResolvedAddress, type SafeFetchResponse } from "../lib/safe-fetch.ts";
import { selfSignedCertificate } from "./tls-fixture.ts";

/**
 * `safeFetch`'s own tests (P04 packet: "give each a small documented
 * interface and its own tests. Tests use an injected resolver and a local
 * fake server, never the real network."). `isBlockedAddress` is tested
 * directly first — the exact ranges the packet names (loopback, RFC 1918,
 * link-local, the cloud metadata address) — then `safeFetch` end to end
 * against a real local `http.Server`, reached through an injected
 * `performRequest` that always connects to it regardless of which fictional
 * hostname the test's injected `resolve` claims it resolved to. This
 * exercises every check in `safeFetch` itself (scheme, address validation on
 * every redirect hop, the redirect limit, the size cap, the timeout, and the
 * content-type gate) without ever touching a real socket to the internet or
 * a real DNS resolver.
 */

// --- isBlockedAddress ------------------------------------------------------

describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", "IPv4 loopback"],
    ["127.255.255.255", "IPv4 loopback range"],
    ["10.0.0.1", "RFC 1918 10/8"],
    ["172.16.0.1", "RFC 1918 172.16/12 (low end)"],
    ["172.31.255.255", "RFC 1918 172.16/12 (high end)"],
    ["192.168.1.1", "RFC 1918 192.168/16"],
    ["169.254.169.254", "link-local metadata address"],
    ["169.254.1.1", "link-local 169.254/16"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "CGNAT shared address space"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456:789a::1", "IPv6 unique local (fd)"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped IPv6 loopback"],
    ["::ffff:10.1.2.3", "IPv4-mapped IPv6 private"],
    ["not-an-ip", "not a literal address at all"],
    // Round-1 review issue 2's IPv6 table (logs/handoff/P04-round-1-review.md):
    // every one of these slipped through the old string-prefix matching.
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["::ffff:a9fe:a9fe", "IPv4-mapped 169.254.169.254, hex form"],
    ["0:0:0:0:0:ffff:7f00:1", "IPv4-mapped loopback, uncompressed"],
    ["0:0:0:0:0:0:0:1", "loopback, uncompressed"],
    ["0000::1", "loopback, zero-padded"],
    ["::127.0.0.1", "IPv4-compatible loopback (deprecated)"],
    ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
    ["fec0::1", "site-local (deprecated)"],
    ["fe80::1%lo0", "link-local with a zone id"],
    // Round-2 review T7: ranges the round-2 reviewer found still allowed.
    ["::ffff:0:7f00:1", "IPv4-translated ::ffff:0:0:0/96, embedding 127.0.0.1"],
    ["::ffff:0:a9fe:a9fe", "IPv4-translated, embedding the metadata address"],
    ["0:0:0:0:ffff:0:a00:1", "IPv4-translated, uncompressed, embedding 10.0.0.1"],
    ["64:ff9b:1::1", "local-use NAT64 64:ff9b:1::/48, blocked entirely"],
    ["64:ff9b:1::5db8:d822", "local-use NAT64, blocked entirely even when it embeds a public IPv4 address"],
    ["2002::1", "6to4 2002::/16, blocked entirely"],
    ["2002:5db8:d822::1", "6to4, blocked entirely even when it encodes a public IPv4 address"],
    ["198.18.0.1", "benchmarking 198.18.0.0/15 (low end)"],
    ["198.19.255.255", "benchmarking 198.18.0.0/15 (high end)"],
    ["192.0.0.1", "IETF protocol assignments 192.0.0.0/24"],
    ["192.0.0.255", "IETF protocol assignments 192.0.0.0/24 (high end)"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["93.184.216.34", "an ordinary public IPv4 address"],
    ["8.8.8.8", "another ordinary public IPv4 address"],
    ["2606:2800:220:1:248:1893:25c8:1946", "an ordinary public IPv6 address"],
    ["::ffff:93.184.216.34", "an IPv4-mapped IPv6 address embedding a public IPv4 address (L2: checked by its embedded IPv4, not the whole ::ffff:0:0/96 range)"],
    ["64:ff9b::93.184.216.34", "a NAT64 address embedding a public IPv4 address"],
    ["::ffff:0:5db8:d822", "an IPv4-translated address embedding a public IPv4 address (T7: checked by its embedded IPv4)"],
    ["198.20.0.1", "just above 198.18.0.0/15"],
    ["198.17.255.255", "just below 198.18.0.0/15"],
    ["192.0.1.1", "just above 192.0.0.0/24"],
    ["2003::1", "just above 2002::/16"],
    ["64:ff9b:2::1", "just above 64:ff9b:1::/48"],
  ])("allows %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("nodeHttpsRequest: the production transport (mutation targets: M6b hand the transport the hostname, M7 remove the pin; round-1 review issue 1)", () => {
  let servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const server of servers) server.close();
    servers = [];
  });

  it("connects to the pinned address, not to any real DNS answer for the URL's hostname — Node 24's autoSelectFamily calls the pinned lookup with { all: true }", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy(); // the TLS handshake will fail; only the TCP connection target is under test.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a port");

    // A hostname real DNS can never answer: if the old (unconditional 3-argument) lookup callback shape were
    // still in place, Node's autoSelectFamily would call it with { all: true }, get back a bare string where it
    // expected an array, and every real request would throw ERR_INVALID_IP_ADDRESS before ever reaching the wire.
    await expect(
      nodeHttpsRequest({ url: new URL(`https://never-resolvable.invalid:${address.port}/posting`), address: "127.0.0.1", signal: AbortSignal.timeout(3000) }),
    ).rejects.toThrow(); // the plain TCP listener isn't real TLS, so the handshake itself fails — that's expected.
    expect(connections).toBe(1); // but the connection reached the pinned address first.
  });
});

describe("safeFetch: a DNS name connects to the checked address (round-2 review T7, mutation target: M6b for a DNS name)", () => {
  it("hands the transport the address the resolver answered and the check passed, never the hostname", async () => {
    const seen: Array<{ host: string; address: string }> = [];
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: async () => PUBLIC_ADDRESS,
      performRequest: async ({ url, address }) => {
        seen.push({ host: url.hostname, address });
        return { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: (async function* () { yield new TextEncoder().encode("ok"); })(), cancel: () => undefined };
      },
    });
    expect(result).toMatchObject({ ok: true, text: "ok" });
    expect(seen).toEqual([{ host: "jobs.example", address: "93.184.216.34" }]);
  });
});

describe("the real transport against a local TLS server (round-2 review T4 and T7)", () => {
  // The fictional host the in-memory certificate names. It has no real DNS answer, so every connection below can
  // only have gone through the pinned lookup.
  const HOST = "jobs.example";
  let server: https.Server;
  let port = 0;
  let previousCa: https.AgentOptions["ca"];
  const drips = new Set<ReturnType<typeof setInterval>>();

  function drip(res: ServerResponse): void {
    const timer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write("d");
    }, 50);
    drips.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      drips.delete(timer);
    });
  }

  beforeAll(async () => {
    const { key, cert } = selfSignedCertificate(HOST);
    previousCa = https.globalAgent.options.ca;
    https.globalAgent.options.ca = cert; // trusted by this test file's own process only
    server = https.createServer({ key, cert }, (req, res) => {
      switch (new URL(req.url ?? "/", "https://placeholder").pathname) {
        case "/ok":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("Staff Platform Engineer at Northwind Labs. Fictional posting.");
          return;
        case "/drip":
          res.writeHead(200, { "content-type": "text/plain" });
          drip(res);
          return;
        case "/redirect-drip":
          res.writeHead(302, { location: "/ok", "content-type": "text/plain" });
          drip(res);
          return;
        case "/reset-mid-body":
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("partial");
          setTimeout(() => res.socket?.destroy(), 100);
          return;
        case "/endless": {
          res.writeHead(200, { "content-type": "text/plain" });
          const chunk = Buffer.alloc(64 * 1024, 0x7a);
          const pump = () => {
            while (!res.destroyed && res.write(chunk)) {
              // keep writing until the socket pushes back
            }
          };
          res.on("drain", pump);
          pump();
          return;
        }
        default:
          res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a port");
    port = address.port;
  });

  afterAll(async () => {
    for (const timer of drips) clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    https.globalAgent.options.ca = previousCa;
  });

  /**
   * The real transport, reached through a DNS name. The resolver answers a public address, which passes the
   * check; this wrapper refuses to go on unless the transport was handed exactly that checked address, then
   * points the real transport at the local server instead (the public address is fictional and unreachable).
   */
  function realTransportToLocal(seen: string[]): PerformRequest {
    return (input) => {
      seen.push(input.address);
      if (input.address !== PUBLIC_ADDRESS[0]!.address) return Promise.reject(new Error(`handed ${input.address}, not the checked address`));
      return nodeHttpsRequest({ ...input, address: "127.0.0.1" });
    };
  }

  it("fetches a DNS name end to end over TLS, connecting through the checked address (M6b for a DNS name)", async () => {
    const seen: string[] = [];
    const result = await safeFetch(`https://${HOST}:${port}/ok`, { resolve: async () => PUBLIC_ADDRESS, performRequest: realTransportToLocal(seen) });
    expect(result).toMatchObject({ ok: true, status: 200, text: "Staff Platform Engineer at Northwind Labs. Fictional posting." });
    expect(seen).toEqual(["93.184.216.34"]);
  });

  it("a slow-drip body gives timeout, not too_large", async () => {
    const started = Date.now();
    const result = await safeFetch(`https://${HOST}:${port}/drip`, { resolve: async () => PUBLIC_ADDRESS, performRequest: realTransportToLocal([]), timeoutMs: 600 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2400); // 4x the 600 ms deadline
  });

  it("a reset mid-body gives request_failed, not too_large", async () => {
    const result = await safeFetch(`https://${HOST}:${port}/reset-mid-body`, { resolve: async () => PUBLIC_ADDRESS, performRequest: realTransportToLocal([]), timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, reason: "request_failed" });
  });

  it("an endless body gives too_large at the default 2 MiB cap", async () => {
    const started = Date.now();
    const result = await safeFetch(`https://${HOST}:${port}/endless`, { resolve: async () => PUBLIC_ADDRESS, performRequest: realTransportToLocal([]), timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(Date.now() - started).toBeLessThan(20_000); // 4x the 5 s deadline
  });

  it("a redirect whose body drips is cancelled, and its target still loads", async () => {
    const seen: string[] = [];
    const result = await safeFetch(`https://${HOST}:${port}/redirect-drip`, { resolve: async () => PUBLIC_ADDRESS, performRequest: realTransportToLocal(seen), timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, finalUrl: `https://${HOST}:${port}/ok` });
    expect(seen).toEqual(["93.184.216.34", "93.184.216.34"]); // both hops resolved and checked again
  });
});

describe("safeFetch: IPv6 URL literals (round-1 review issue 2)", () => {
  it("refuses a bracketed loopback literal without ever calling resolve or performRequest — the old code sent '[::1]' to the resolver as if it were a hostname", async () => {
    const resolveCalls: string[] = [];
    let requests = 0;
    const result = await safeFetch("https://[::1]/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS, resolveCalls),
      performRequest: async () => {
        requests += 1;
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(resolveCalls).toEqual([]);
    expect(requests).toBe(0);
  });

  it("refuses a bracketed IPv4-mapped metadata literal the same way", async () => {
    const result = await safeFetch("https://[::ffff:169.254.169.254]/", {
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("treats a bracketed public IPv6 literal as the literal it is: skips resolve, and reaches performRequest with that exact address", async () => {
    const resolveCalls: string[] = [];
    const seenAddresses: string[] = [];
    const result = await safeFetch("https://[2606:2800:220:1:248:1893:25c8:1946]/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS, resolveCalls),
      performRequest: async ({ address }) => {
        seenAddresses.push(address);
        return { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: (async function* () { yield new TextEncoder().encode("ok"); })(), cancel: () => undefined };
      },
    });
    expect(resolveCalls).toEqual([]); // a literal never goes through the resolver
    expect(seenAddresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946"]);
    expect(result).toMatchObject({ ok: true, text: "ok" });
  });
});

// --- safeFetch --------------------------------------------------------------

/** A real local server, so `safeFetch`'s body/redirect/content-type handling runs against a genuine socket. Routes by pathname. */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startFakeServer(routes: Record<string, RouteHandler>): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Ignores the (fictional, test-only) `address` argument and always connects to the real local fake server. */
function performRequestVia(port: number): PerformRequest {
  return async ({ url, signal }) => {
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { signal, redirect: "manual" });
    // A web stream that safeFetch is iterating is locked to that iterator (safeFetch closes the iterator itself); only
    // an unread body can be cancelled here. Safe to call more than once, as the PerformRequest contract requires.
    const cancel = () => {
      if (response.body && !response.body.locked) response.body.cancel().catch(() => undefined);
    };
    return { status: response.status, headers: response.headers, body: response.body ?? (async function* () {})(), cancel } as SafeFetchResponse;
  };
}

const PUBLIC_ADDRESS: readonly ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

function resolveTo(addresses: readonly ResolvedAddress[], calls: string[] = []) {
  return async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    calls.push(hostname);
    return addresses;
  };
}

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe("safeFetch: the scheme gate", () => {
  it("rejects a plain http:// URL before ever resolving or connecting", async () => {
    const resolveCalls: string[] = [];
    let requests = 0;
    const result = await safeFetch("http://jobs.example/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS, resolveCalls),
      performRequest: async () => {
        requests += 1;
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "scheme_not_https" });
    expect(resolveCalls).toEqual([]);
    expect(requests).toBe(0);
  });

  it("rejects javascript: and file: URLs the same way", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const result = await safeFetch(url, { performRequest: async () => { throw new Error("must never be called"); } });
      expect(result.ok, url).toBe(false);
    }
  });

  it("rejects an unparsable URL", async () => {
    const result = await safeFetch("not a url", { performRequest: async () => { throw new Error("must never be called"); } });
    expect(result).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

describe("safeFetch: address blocking (mutation target: 'drop the post-redirect address check')", () => {
  it("rejects when the resolver answers with a loopback address, without ever connecting", async () => {
    let requests = 0;
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo([{ address: "127.0.0.1", family: 4 }]),
      performRequest: async () => {
        requests += 1;
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(requests).toBe(0);
  });

  it("rejects the cloud metadata address", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo([{ address: "169.254.169.254", family: 4 }]),
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("rejects a raw loopback IP literal in the URL itself, skipping DNS entirely", async () => {
    const resolveCalls: string[] = [];
    const result = await safeFetch("https://127.0.0.1/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS, resolveCalls),
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(resolveCalls).toEqual([]); // a literal IP never goes through the resolver
  });

  it("rejects when ANY of several resolved addresses is blocked, even if another is public", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]),
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("rejects when DNS resolves nothing", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: async () => [],
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "dns_failed" });
  });

  it("re-validates on every redirect hop: a redirect to a blocked address is refused after only the first request", async () => {
    const server = await startFakeServer({
      "/start": (_req, res) => {
        res.writeHead(302, { location: "https://internal.example/secret" });
        res.end();
      },
    });
    servers.push(server);
    const resolveCalls: string[] = [];
    const resolve = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
      resolveCalls.push(hostname);
      return hostname === "internal.example" ? [{ address: "169.254.169.254", family: 4 }] : PUBLIC_ADDRESS;
    };
    let requests = 0;
    const performRequest: PerformRequest = async (input) => {
      requests += 1;
      return performRequestVia(server.port)(input);
    };
    const result = await safeFetch("https://jobs.example/start", { resolve, performRequest });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(resolveCalls).toEqual(["jobs.example", "internal.example"]);
    expect(requests).toBe(1); // the second hop was blocked before ever connecting
  });
});

describe("safeFetch: a successful fetch through the local fake server", () => {
  it("follows an allowed redirect and returns the final page's text and content-type", async () => {
    const server = await startFakeServer({
      "/start": (_req, res) => {
        res.writeHead(302, { location: "/posting" });
        res.end();
      },
      "/posting": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><p>Staff Engineer at Northwind Labs</p></body></html>");
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/start", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port) });
    expect(result).toMatchObject({ ok: true, status: 200, contentType: "text/html" });
    if (result.ok) {
      expect(result.text).toContain("Staff Engineer at Northwind Labs");
      expect(result.finalUrl).toBe("https://jobs.example/posting");
    }
  });

  it("accepts text/plain too", async () => {
    const server = await startFakeServer({
      "/posting.txt": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Plain-text posting.");
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/posting.txt", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port) });
    expect(result).toMatchObject({ ok: true, contentType: "text/plain", text: "Plain-text posting." });
  });
});

describe("safeFetch: the redirect limit", () => {
  it("gives up after maxRedirects hops, never completing an unbounded chain", async () => {
    const server = await startFakeServer({
      "/loop": (_req, res) => {
        res.writeHead(302, { location: "/loop" });
        res.end();
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/loop", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port), maxRedirects: 3 });
    expect(result).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });
});

describe("safeFetch: the size cap", () => {
  it("rejects an endless body as too_large — the cap is checked incrementally while streaming, not after buffering the whole body (mutation target: M8, checking the cap only after buffering everything, which reaches the deadline instead)", async () => {
    const started = Date.now();
    const result = await safeFetch("https://jobs.example/endless", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      maxBytes: 1000,
      timeoutMs: 500,
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: (async function* () {
          const chunk = new Uint8Array(256);
          for (;;) yield chunk; // never ends: buffering the whole thing before checking would never resolve at all.
        })(),
        cancel: () => undefined,
      }),
    });
    const elapsedMs = Date.now() - started;
    expect(result).toMatchObject({ ok: false, reason: "too_large" }); // M8 gives "timeout" here: the reason is the real assertion
    expect(elapsedMs).toBeLessThan(2000); // 4x the 500 ms deadline (round-2 review T4's headroom rule)
  });

  it("rejects a body larger than maxBytes without ever returning the oversized text", async () => {
    const server = await startFakeServer({
      "/big": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(1000));
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/big", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port), maxBytes: 100 });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });
});

describe("safeFetch: the content-type gate", () => {
  it("rejects anything other than text/html or text/plain", async () => {
    const server = await startFakeServer({
      "/data.json": (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/data.json", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port) });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_content_type" });
  });
});

describe("safeFetch: timeouts and transport failures", () => {
  it("reports a timeout when the deadline aborts a request whose headers never arrive", async () => {
    const result = await safeFetch("https://jobs.example/slow", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      timeoutMs: 100,
      // What the real transport does with the signal: https.request rejects with an AbortError once it fires.
      performRequest: ({ signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports request_failed, not timeout, for an AbortError that is not the deadline (T4: classified by cause, not by the error's name)", async () => {
    const result = await safeFetch("https://jobs.example/aborted", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "request_failed" });
  });

  it("reports request_failed for any other transport error", async () => {
    const result = await safeFetch("https://jobs.example/down", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => {
        throw new Error("connection reset");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "request_failed" });
    if (!result.ok) expect(result.message).toContain("connection reset");
  });

  it("rejects a non-2xx status", async () => {
    const server = await startFakeServer({
      "/missing": (_req, res) => {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html>not found</html>");
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/missing", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port) });
    expect(result).toMatchObject({ ok: false, reason: "http_status" });
  });

  it("rejects a redirect with no Location header", async () => {
    const server = await startFakeServer({
      "/nowhere": (_req, res) => {
        res.writeHead(302, {});
        res.end();
      },
    });
    servers.push(server);
    const result = await safeFetch("https://jobs.example/nowhere", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port) });
    expect(result).toMatchObject({ ok: false, reason: "redirect_missing_location" });
  });
});

/** The error the real transport's body throws both when the deadline destroys the socket and when the server resets it (round-2 reviewer probe `abort-error-shape-probe.mjs`): the same shape either way. */
function econnreset(): Error {
  return Object.assign(new Error("aborted"), { code: "ECONNRESET" });
}

describe("safeFetch: body errors are classified by cause, and it never throws (round-1 review issue 4, round-2 review T4)", () => {
  it("resolves timeout when the deadline destroys a slow body, even though the body throws a plain ECONNRESET", async () => {
    const result = await safeFetch("https://jobs.example/slow-drip", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      timeoutMs: 100,
      // Mimics the real transport: the deadline signal destroys the socket, and the body's iterator then throws
      // ECONNRESET "aborted", which on its own says nothing about why.
      performRequest: async ({ signal }) => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: (async function* () {
          yield new TextEncoder().encode("partial");
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(econnreset()), { once: true }));
        })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("resolves timeout when a body neither ends nor errors, even if the transport ignores the deadline signal", async () => {
    const started = Date.now();
    let cancelled = false;
    const result = await safeFetch("https://jobs.example/stalled", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      timeoutMs: 100,
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: (async function* () {
          yield new TextEncoder().encode("partial");
          await new Promise(() => {}); // never settles, never looks at the signal
        })(),
        cancel: () => {
          cancelled = true;
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(cancelled).toBe(true); // the abandoned body is closed, not left holding a connection
    expect(Date.now() - started).toBeLessThan(400); // 4x the 100 ms deadline
  });

  it("resolves request_failed, not too_large, when the body stream throws mid-read before the deadline", async () => {
    const result = await safeFetch("https://jobs.example/broken-body", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: (async function* () {
          yield new TextEncoder().encode("partial");
          throw econnreset();
        })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "request_failed" });
  });

  it("resolves request_failed for an abort that is not the deadline", async () => {
    const result = await safeFetch("https://jobs.example/aborted-elsewhere", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: (async function* () {
          yield new TextEncoder().encode("partial");
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "request_failed" });
  });
});

describe("safeFetch: one overall deadline covers DNS, every hop and the body (round-1 review issue 4, nit 'applies per hop')", () => {
  it("a slow resolver is bounded by timeoutMs — DNS is not exempt from the deadline", async () => {
    const started = Date.now();
    const result = await safeFetch("https://jobs.example/posting", {
      timeoutMs: 200,
      resolve: () => new Promise(() => {}), // never resolves
      performRequest: async () => {
        throw new Error("must never be called");
      },
    });
    const elapsedMs = Date.now() - started;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(elapsedMs).toBeLessThan(1000); // 5x the 200 ms deadline; the reason above is the real assertion
  });

  it("a redirect chain's total time is bounded by one timeoutMs, not a fresh allowance per hop", async () => {
    const server = await startFakeServer({
      "/hop1": (_req, res) => {
        setTimeout(() => {
          res.writeHead(302, { location: "/hop2" });
          res.end();
        }, 150);
      },
      "/hop2": (_req, res) => {
        setTimeout(() => {
          res.writeHead(302, { location: "/hop3" });
          res.end();
        }, 150);
      },
      "/hop3": (_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("too slow");
        }, 150);
      },
    });
    servers.push(server);
    const started = Date.now();
    const result = await safeFetch("https://jobs.example/hop1", { resolve: resolveTo(PUBLIC_ADDRESS), performRequest: performRequestVia(server.port), timeoutMs: 250 });
    const elapsedMs = Date.now() - started;
    // Three hops at 150ms each is 450ms of server-side delay alone; a fresh 250ms per hop would let this
    // finish (and did, before round-1's fix), so the reason is the real assertion. The time bound is 4x the
    // 250 ms deadline (round-2 review T4: the old 400 ms bound failed once in seven runs at 551 ms).
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("safeFetch: a redirect's body is cancelled, not drained (round-1 review L4)", () => {
  it("never iterates a redirect's body, and calls cancel on it", async () => {
    let iterated = false;
    let cancelled = false;
    const result = await safeFetch("https://jobs.example/start", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async ({ url }) => {
        if (url.pathname === "/start") {
          return {
            status: 302,
            headers: new Headers({ location: "/posting" }),
            body: (async function* () {
              iterated = true;
              yield new Uint8Array();
            })(),
            cancel: () => {
              cancelled = true;
            },
          };
        }
        return { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: (async function* () { yield new TextEncoder().encode("ok"); })(), cancel: () => undefined };
      },
    });
    expect(result).toMatchObject({ ok: true, text: "ok" });
    expect(cancelled).toBe(true);
    expect(iterated).toBe(false);
  });
});

describe("safeFetch: compression and charset (round-1 review nits)", () => {
  it("refuses a response declaring gzip content-encoding", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain", "content-encoding": "gzip" }),
        body: (async function* () { yield new TextEncoder().encode("compressed bytes, not real gzip"); })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_content_type" });
  });

  it("allows a response that explicitly declares identity encoding", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain", "content-encoding": "identity" }),
        body: (async function* () { yield new TextEncoder().encode("plain text"); })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: true, text: "plain text" });
  });

  it("honours a declared charset TextDecoder supports", async () => {
    const latin1Bytes = new Uint8Array([0xe9]); // 'é' in ISO-8859-1, not valid standalone UTF-8
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain; charset=iso-8859-1" }),
        body: (async function* () { yield latin1Bytes; })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: true, text: "é" });
  });

  it("falls back to UTF-8 for a declared charset TextDecoder does not support", async () => {
    const result = await safeFetch("https://jobs.example/posting", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain; charset=made-up-charset" }),
        body: (async function* () { yield new TextEncoder().encode("plain utf-8 text"); })(),
        cancel: () => undefined,
      }),
    });
    expect(result).toMatchObject({ ok: true, text: "plain utf-8 text" });
  });
});
