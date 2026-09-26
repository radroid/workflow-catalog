import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_ORIGIN, createBridgeClient, FOREIGN_SERVER_MESSAGE, MAX_RESPONSE_CHARS, type BridgeClient } from "./bridge-client";

/** A fictional job_capture, contracts-shaped (see fixtures-policy.md). */
const CAPTURE = {
  protocol: 1 as const,
  type: "job_capture" as const,
  eventId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
  url: "https://jobs.example/postings/1",
  text: "Backend Engineer — Quill, a fictional posting for tests.",
  extractorVersion: "extractor@0.1.0",
  contentHash: "a".repeat(64),
  occurredAt: "2026-09-22T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("createBridgeClient: never calls fetch before a request is warranted", () => {
  it("pair() never reads a device token (pairing has none yet)", async () => {
    let tokenReads = 0;
    stubFetch(() => jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "tok" }));
    const client = createBridgeClient({ getToken: () => { tokenReads += 1; return Promise.resolve(null); } });
    await client.pair({ code: "7KQ2M-X9RTB" });
    expect(tokenReads).toBe(0);
  });

  it("postEvent()/getCommands()/getStatus() return not_paired without ever calling fetch when there is no stored token", async () => {
    stubFetch(() => {
      throw new Error("must not call fetch without a device token");
    });
    const client = createBridgeClient({ getToken: () => Promise.resolve(null) });

    const eventResult = await client.postEvent(CAPTURE);
    expect(eventResult).toEqual({ ok: false, error: { code: "not_paired", message: expect.stringContaining("Pair") } });

    const commandsResult = await client.getCommands();
    expect(commandsResult.ok).toBe(false);
    if (!commandsResult.ok) expect(commandsResult.error.code).toBe("not_paired");

    const statusResult = await client.getStatus();
    expect(statusResult.ok).toBe(false);
    if (!statusResult.ok) expect(statusResult.error.code).toBe("not_paired");

    expect(calls).toEqual([]);
  });
});

describe("createBridgeClient: pair()", () => {
  it("posts the code to /pair against the bridge origin, with no Authorization header, and returns the validated response", async () => {
    stubFetch((url) => {
      expect(url).toBe(`${BRIDGE_ORIGIN}/pair`);
      return jsonResponse(200, { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" });
    });
    const client = createBridgeClient();
    const result = await client.pair({ code: "7KQ2M-X9RTB" });
    expect(result).toEqual({ ok: true, value: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "opaque-token" } });
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("carries the bridge's HTTP status and error code through on a wrong/expired code (not just a message)", async () => {
    stubFetch(() =>
      jsonResponse(401, { ok: false, error: { code: "pairing_code_invalid", message: "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run `npm run pair` for a new one." } }),
    );
    const client = createBridgeClient();
    const result = await client.pair({ code: "AAAAA-AAAAA" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(401);
    expect(result.error.code).toBe("pairing_code_invalid");
    expect(result.error.message).toContain("npm run pair");
  });

  it("carries a 429 too_many_attempts through, with the Retry-After header parsed as retryAfterSeconds (P07-B revision 1, B8)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: "too_many_attempts", message: "Too many wrong pairing codes. Wait, then issue a new code with `npm run pair`." } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "137" } },
      )) as typeof fetch;
    const client = createBridgeClient();
    const result = await client.pair({ code: "AAAAA-AAAAA" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(429);
    expect(result.error.code).toBe("too_many_attempts");
    expect(result.error.retryAfterSeconds).toBe(137);
  });

  it("leaves retryAfterSeconds undefined when the response has no Retry-After header", async () => {
    stubFetch(() => jsonResponse(401, { ok: false, error: { code: "pairing_code_invalid", message: "invalid" } }));
    const client = createBridgeClient();
    const result = await client.pair({ code: "AAAAA-AAAAA" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryAfterSeconds).toBeUndefined();
  });

  it("classifies a fetch rejection (runner not running) as network_error, with an actionable message", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const client = createBridgeClient();
    const result = await client.pair({ code: "7KQ2M-X9RTB" });
    expect(result).toEqual({
      ok: false,
      error: { code: "network_error", message: expect.stringContaining("npm run runner") },
    });
  });

  it("rejects a response that doesn't match PairResponse's shape instead of returning it as-is", async () => {
    stubFetch(() => jsonResponse(200, { deviceId: "not-a-uuid" }));
    const client = createBridgeClient();
    const result = await client.pair({ code: "7KQ2M-X9RTB" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_response");
  });
});

describe("createBridgeClient: authenticated routes (postEvent, getCommands, getStatus)", () => {
  function pairedClient(): BridgeClient {
    return createBridgeClient({ getToken: () => Promise.resolve({ token: "device-token" }) });
  }

  it("postEvent sends Authorization: Bearer <token> and reports duplicate:false on a fresh save", async () => {
    stubFetch((url) => {
      expect(url).toBe(`${BRIDGE_ORIGIN}/events`);
      return jsonResponse(200, { ok: true, eventId: CAPTURE.eventId, type: "job_capture", duplicate: false, outcome: "journaled" });
    });
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result).toEqual({ ok: true, value: { duplicate: false } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer device-token");
  });

  it("postEvent reports duplicate:true as success, the same as a fresh save (gate 1: a replay is still 'saved')", async () => {
    stubFetch(() => jsonResponse(200, { ok: true, eventId: CAPTURE.eventId, type: "job_capture", duplicate: true, outcome: "journaled" }));
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result).toEqual({ ok: true, value: { duplicate: true } });
  });

  it("postEvent treats 202 (no handler yet -- P04 adds one) as success", async () => {
    stubFetch(() => jsonResponse(202, { ok: true, eventId: CAPTURE.eventId, type: "job_capture", duplicate: false, outcome: "journaled" }));
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result.ok).toBe(true);
  });

  it("postEvent carries a 401 token_invalid through (expired/revoked token: re-pair), and calls onTokenInvalid so a dead token stops being offered as paired (P07-B revision 1, B3)", async () => {
    stubFetch(() => jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." } }));
    let calls = 0;
    const client = createBridgeClient({ getToken: () => Promise.resolve({ token: "device-token" }), onTokenInvalid: () => { calls += 1; return Promise.resolve(); } });
    const result = await client.postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(401);
    expect(result.error.code).toBe("token_invalid");
    expect(calls).toBe(1);
  });

  it("postEvent carries a 403 origin_not_allowed through (wrong extension or device: re-pair), and calls onOriginMismatch so the options page can learn about it even though GET /status never would (P07-B revision 1, B3)", async () => {
    stubFetch(() => jsonResponse(403, { ok: false, error: { code: "origin_not_allowed", message: "This request's Origin is not the extension origin this device paired from." } }));
    let calls = 0;
    const client = createBridgeClient({ getToken: () => Promise.resolve({ token: "device-token" }), onOriginMismatch: () => { calls += 1; return Promise.resolve(); } });
    const result = await client.postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(403);
    expect(result.error.code).toBe("origin_not_allowed");
    expect(calls).toBe(1);
  });

  it("postEvent calls neither hook on a 413 or other non-401/403 failure", async () => {
    stubFetch(() => jsonResponse(413, { ok: false, error: { code: "body_too_large", message: "too big" } }));
    let tokenInvalidCalls = 0;
    let originMismatchCalls = 0;
    const client = createBridgeClient({
      getToken: () => Promise.resolve({ token: "device-token" }),
      onTokenInvalid: () => { tokenInvalidCalls += 1; return Promise.resolve(); },
      onOriginMismatch: () => { originMismatchCalls += 1; return Promise.resolve(); },
    });
    await client.postEvent(CAPTURE);
    expect(tokenInvalidCalls).toBe(0);
    expect(originMismatchCalls).toBe(0);
  });

  it("postEvent classifies the runner being down as network_error", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("network_error");
    expect(result.error.status).toBeUndefined();
  });

  it("postEvent classifies a request that never answers (AbortSignal.timeout firing) as network_error with a distinct 'isn't responding' message (P07-B revision 1, B4)", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject((init.signal as AbortSignal).reason as Error);
        });
      });
    }) as typeof fetch;
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("network_error");
    // P07-B revision 2 polish: the same distinct opening, now with a next step.
    expect(result.error.message).toBe("The runner isn't responding. Wait a moment and try again, or restart it with `npm run runner`.");
  }, 10_000);

  it("postEvent rejects a 200 whose body doesn't say ok:true (defence against something other than the bridge answering on the port) (P07-B revision 1, B4)", async () => {
    stubFetch(() => jsonResponse(200, { unrelated: "shape" }));
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_response");
  });

  it("postEvent rejects a 200 whose eventId doesn't match the one just sent (a genuine bridge response meant for a different request) (P07-B revision 1, B4)", async () => {
    stubFetch(() => jsonResponse(200, { ok: true, eventId: "not-the-event-id-we-sent", type: "job_capture", duplicate: false, outcome: "journaled" }));
    const result = await pairedClient().postEvent(CAPTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_response");
  });

  it("P07-B revision 2, B5: postEvent rejects a 200 that echoes the right eventId but doesn't say ok:true", async () => {
    // The wrong-body test above lacks eventId too, so it passed with the
    // ok:true check deleted; this body isolates that check.
    for (const body of [
      { eventId: CAPTURE.eventId, duplicate: false },
      { ok: "true", eventId: CAPTURE.eventId, duplicate: false },
      { ok: false, eventId: CAPTURE.eventId, duplicate: false },
    ]) {
      stubFetch(() => jsonResponse(200, body));
      const result = await pairedClient().postEvent(CAPTURE);
      expect(result, JSON.stringify(body)).toEqual({ ok: false, error: { code: "invalid_response", message: expect.any(String) } });
    }
  });

  it("getStatus sends no query and returns the validated StatusResponse", async () => {
    stubFetch((url) => {
      expect(url).toBe(`${BRIDGE_ORIGIN}/status`);
      return jsonResponse(200, {
        version: "0.1.0",
        workspaceId: "ws_123",
        budget: { dailyRunLimit: 0, runsUsedToday: 0, paused: false },
        schedules: [],
      });
    });
    const result = await pairedClient().getStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspaceId).toBe("ws_123");
  });

  it("getStatus classifies a 429 through unchanged (wait, then npm run pair)", async () => {
    stubFetch(() => jsonResponse(429, { ok: false, error: { code: "too_many_attempts", message: "Too many wrong pairing codes." } }));
    const result = await pairedClient().getStatus();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(429);
  });

  it("P07-B revision 2, B4: the hooks get the token the bridge refused", async () => {
    stubFetch(() => jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "not valid" } }));
    const refused: string[] = [];
    const client = createBridgeClient({
      getToken: () => Promise.resolve({ token: "device-token" }),
      onTokenInvalid: (token) => {
        refused.push(token);
        return Promise.resolve();
      },
    });
    await client.getStatus();
    expect(refused).toEqual(["device-token"]);
    expect(calls, "the same token again would only be refused again").toHaveLength(1);
  });

  it("P07-B revision 2, B4: a 401 or 403 that isn't in the bridge's envelope (something else on the port) calls no hook and is not retried", async () => {
    for (const status of [401, 403]) {
      calls = [];
      stubFetch(() => new Response("<html>not the bridge</html>", { status, headers: { "content-type": "text/html" } }));
      let hookCalls = 0;
      const client = createBridgeClient({
        getToken: () => Promise.resolve({ token: "device-token" }),
        onTokenInvalid: () => { hookCalls += 1; return Promise.resolve(); },
        onOriginMismatch: () => { hookCalls += 1; return Promise.resolve(); },
      });
      const result = await client.postEvent(CAPTURE);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ status, code: "unknown_error" });
      expect(hookCalls, `HTTP ${status}`).toBe(0);
      expect(calls).toHaveLength(1);
    }
  });

  it("P07-B revision 3, H2: every answer that isn't the runner's carries one plain sentence with a next step -- no field names, no status codes", async () => {
    const answers: Array<[string, () => Response, (client: BridgeClient) => Promise<{ ok: boolean; error?: { code: string; message: string } }>]> = [
      ["pair, a web page", () => new Response("<html>another program</html>", { status: 200, headers: { "content-type": "text/html" } }), (client) => client.pair({ code: "7KQ2M-X9RTB" })],
      ["postEvent, JSON that isn't the answer", () => jsonResponse(200, { unrelated: "shape" }), (client) => client.postEvent(CAPTURE)],
      ["getStatus, a web page", () => new Response("<html>another program</html>", { status: 200, headers: { "content-type": "text/html" } }), (client) => client.getStatus()],
      ["getCommands, a 404 outside the envelope", () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }), (client) => client.getCommands()],
      ["getStatus, a 500 outside the envelope", () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }), (client) => client.getStatus()],
    ];
    for (const [name, answer, send] of answers) {
      stubFetch(() => answer());
      const result = await send(pairedClient());
      expect(result.ok, name).toBe(false);
      expect(result.error?.code, name).toMatch(/^(invalid_response|unknown_error)$/);
      expect(result.error?.message, name).toBe(FOREIGN_SERVER_MESSAGE);
    }
    expect(FOREIGN_SERVER_MESSAGE).not.toMatch(/HTTP|shape|\b[1-5]\d\d\b|invalid_response|unknown_error/);
  });

  it("getCommands appends ?since= only when given, and validates the response", async () => {
    stubFetch((url) => {
      expect(url).toBe(`${BRIDGE_ORIGIN}/commands`);
      return jsonResponse(200, { commands: [] });
    });
    const withoutSince = await pairedClient().getCommands();
    expect(withoutSince).toEqual({ ok: true, value: { commands: [] } });

    calls = [];
    stubFetch((url) => {
      expect(url).toBe(`${BRIDGE_ORIGIN}/commands?since=2026-09-22T09%3A00%3A00.000Z`);
      return jsonResponse(200, { commands: [] });
    });
    await pairedClient().getCommands("2026-09-22T09:00:00.000Z");
  });

  it("P07 part C, gate 7: an answer larger than MAX_RESPONSE_CHARS is never parsed -- read as another program's, declared or not", async () => {
    const padding = "x".repeat(MAX_RESPONSE_CHARS + 1);
    stubFetch(() => new Response(JSON.stringify({ commands: [], padding }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await pairedClient().getCommands()).toMatchObject({ ok: false, error: { code: "invalid_response" } });

    stubFetch(() => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(MAX_RESPONSE_CHARS + 1) } }));
    expect(await pairedClient().getCommands()).toMatchObject({ ok: false, error: { code: "invalid_response" } });

    stubFetch(() => jsonResponse(200, { commands: [] }));
    expect(await pairedClient().getCommands(), "an answer of a normal size still passes").toEqual({ ok: true, value: { commands: [] } });
  });
});

describe("P07-B revision 2, B4: a refusal for a token that a new pairing replaced mid-request", () => {
  /** The stored token, as the options page's pairing would change it. */
  function tokenStore(initial: string | null) {
    let current = initial;
    return {
      get: () => Promise.resolve(current === null ? null : { token: current }),
      set: (next: string | null) => {
        current = next;
      },
    };
  }

  function authorizations(): Array<string | undefined> {
    return calls.map((call) => (call.init.headers as Record<string, string>).authorization);
  }

  const ACCEPTED = { ok: true, eventId: CAPTURE.eventId, type: "job_capture", duplicate: false, outcome: "journaled" };

  for (const [status, code] of [
    [401, "token_invalid"],
    [403, "origin_not_allowed"],
  ] as const) {
    it(`probe P5: a ${status} ${code} for the old token, after a pairing stored a new one, is retried once with the new token and runs no hook`, async () => {
      const store = tokenStore("old-token");
      stubFetch((_url, init) => {
        if ((init.headers as Record<string, string>).authorization === "Bearer old-token") {
          store.set("new-token"); // the pairing finished while this request was in flight
          return jsonResponse(status, { ok: false, error: { code, message: "refused" } });
        }
        return jsonResponse(200, ACCEPTED);
      });
      let hookCalls = 0;
      const client = createBridgeClient({
        getToken: store.get,
        onTokenInvalid: () => { hookCalls += 1; return Promise.resolve(); },
        onOriginMismatch: () => { hookCalls += 1; return Promise.resolve(); },
      });

      const result = await client.postEvent(CAPTURE);

      expect(result).toEqual({ ok: true, value: { duplicate: false } });
      expect(authorizations()).toEqual(["Bearer old-token", "Bearer new-token"]);
      expect(hookCalls, "the old token's refusal must not clear or flag the new pairing").toBe(0);
    });
  }

  it("a retry refused because the token was replaced yet again returns token_replaced (retryable), and runs no hook", async () => {
    const store = tokenStore("token-one");
    stubFetch((_url, init) => {
      const auth = (init.headers as Record<string, string>).authorization;
      store.set(auth === "Bearer token-one" ? "token-two" : "token-three");
      return jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "refused" } });
    });
    let hookCalls = 0;
    const client = createBridgeClient({ getToken: store.get, onTokenInvalid: () => { hookCalls += 1; return Promise.resolve(); } });

    const result = await client.postEvent(CAPTURE);

    expect(result).toEqual({ ok: false, error: { code: "token_replaced", message: expect.any(String) } });
    expect(authorizations()).toEqual(["Bearer token-one", "Bearer token-two"]);
    expect(hookCalls).toBe(0);
  });

  it("a retry refused for the new token, still stored, runs the hook with the new token", async () => {
    const store = tokenStore("old-token");
    stubFetch((_url, init) => {
      if ((init.headers as Record<string, string>).authorization === "Bearer old-token") store.set("new-token");
      return jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "refused" } });
    });
    const refused: string[] = [];
    const client = createBridgeClient({ getToken: store.get, onTokenInvalid: (token) => { refused.push(token); return Promise.resolve(); } });

    const result = await client.postEvent(CAPTURE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ status: 401, code: "token_invalid" });
    expect(refused).toEqual(["new-token"]);
  });

  it("a 401 after the token was removed mid-request (Un-pair) is returned as-is, without a retry", async () => {
    const store = tokenStore("device-token");
    stubFetch(() => {
      store.set(null);
      return jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "refused" } });
    });
    const client = createBridgeClient({ getToken: store.get, onTokenInvalid: () => Promise.resolve() });

    const result = await client.postEvent(CAPTURE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("token_invalid");
    expect(calls).toHaveLength(1);
  });
});
