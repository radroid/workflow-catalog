import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress, safeFetch, type PerformRequest, type ResolvedAddress, type SafeFetchResponse } from "../lib/safe-fetch.ts";

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
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["93.184.216.34", "an ordinary public IPv4 address"],
    ["8.8.8.8", "another ordinary public IPv4 address"],
    ["2606:2800:220:1:248:1893:25c8:1946", "an ordinary public IPv6 address"],
  ])("allows %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
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
  return async ({ url, timeoutMs }) => {
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return { status: response.status, headers: response.headers, body: response.body ?? (async function* () {})() } as SafeFetchResponse;
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
  it("reports a timeout when performRequest aborts", async () => {
    const result = await safeFetch("https://jobs.example/slow", {
      resolve: resolveTo(PUBLIC_ADDRESS),
      performRequest: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
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
