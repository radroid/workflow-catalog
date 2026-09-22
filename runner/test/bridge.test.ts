import { randomUUID } from "node:crypto";
import { MAX_BRIDGE_BODY_BYTES, commandsResponseSchema, statusResponseSchema, type OpenApplicationGroup } from "@workflow-catalog/contracts";
import { describe, expect, it, vi } from "vitest";
import { MINUTE_MS } from "../lib/clock.ts";
import { PAIR_CODE_GUESS_BUDGET, PAIR_FAILURE_LIMIT } from "../server/extension-api.ts";
import { defineRouteModule, EventRejectedError, type LoadedRouteModule } from "../server/route-modules.ts";
import { EXTENSION_ORIGIN, OTHER_EXTENSION_ORIGIN, authed, jobCapture, makeBridge, pairDevice, postEvent, type TestBridge } from "./helpers.ts";

async function errorOf(response: Response): Promise<{ code: string; message: string; issues?: Array<{ path: Array<string | number>; message: string }> }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe("bridge: routes", () => {
  it("answers an unknown route with 404", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    for (const [method, path] of [
      ["GET", "/nope"],
      ["GET", "/pair"],
      ["POST", "/status"],
      ["DELETE", "/events"],
      ["GET", "/eve/v1/session"],
    ] as const) {
      const response = await bridge.request(path, { method, headers: authed(token) });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("refuses any Host but 127.0.0.1:4310 or localhost:4310 (DNS rebinding) with 403", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    for (const host of ["rebind.attacker.example:4310", "127.0.0.1", "127.0.0.1:80", "localhost:3000", "[::1]:4310"]) {
      const response = await bridge.request("/status", { headers: { ...authed(token), host } });
      expect(response.status, host).toBe(403);
      expect((await errorOf(response)).code).toBe("host_not_allowed");
    }
    const localhost = await bridge.request("/status", { headers: { ...authed(token), host: "localhost:4310" } });
    expect(localhost.status).toBe(200);
  });
});

describe("bridge: authentication", () => {
  it("answers a missing token with 401 and a Bearer challenge", async () => {
    const bridge = await makeBridge();
    for (const [method, path] of [
      ["GET", "/status"],
      ["GET", "/commands"],
      ["POST", "/events"],
    ] as const) {
      const response = await bridge.request(path, { method, headers: { origin: EXTENSION_ORIGIN, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect((await errorOf(response)).code).toBe("token_missing");
    }
  });

  it("answers an unknown or malformed token with 401", async () => {
    const bridge = await makeBridge();
    await pairDevice(bridge);
    for (const header of ["Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Bearer", "Basic cnVubmVyOnBhc3M=", "bearer x y"]) {
      const response = await bridge.request("/status", { headers: { authorization: header, origin: EXTENSION_ORIGIN } });
      expect(response.status, header).toBe(401);
    }
  });

  it("answers a valid token from the wrong Origin with 403", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    for (const path of ["/status", "/commands"]) {
      for (const origin of [OTHER_EXTENSION_ORIGIN, "https://jobs.example", "null", "http://127.0.0.1:4310"]) {
        const response = await bridge.request(path, { headers: authed(token, origin) });
        expect(response.status, `${path} ${origin}`).toBe(403);
        expect((await errorOf(response)).code).toBe("origin_not_allowed");
      }
    }
    const post = await postEvent(bridge, token, jobCapture(), OTHER_EXTENSION_ORIGIN);
    expect(post.status).toBe(403);
    expect(await bridge.ctx.journal.list()).toHaveLength(0);
  });

  it("stores only the token's hash", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    const stored = JSON.stringify(await bridge.workspace.readJson(".runner", "devices", `${deviceId}.json`));
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/"tokenSha256": ?"[0-9a-f]{64}"/);
  });

  it("stops accepting a revoked device's token on the next request", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    expect((await bridge.request("/status", { headers: authed(token) })).status).toBe(200);
    expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);
    const after = await bridge.request("/status", { headers: authed(token) });
    expect(after.status).toBe(401);
    expect(await bridge.ctx.devices.list()).toHaveLength(0);
  });

  it("stops accepting a token after it expires (30 days)", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    bridge.clock.advance(30 * 24 * 60 * MINUTE_MS + 1);
    expect((await bridge.request("/status", { headers: authed(token) })).status).toBe(401);
  });
});

describe("bridge: Origin as Chrome sends it", () => {
  // Recorded from Chromium 153 (an MV3 extension page, its service worker and
  // an alarm-driven fetch): GETs carry no Origin; POSTs carry the extension's.
  const chromeGet = (token?: string): Record<string, string> => ({
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    "sec-fetch-site": "none",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });

  it("accepts GET /status and GET /commands with no Origin on a valid token", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const status = await bridge.request("/status", { headers: chromeGet(token) });
    expect(status.status).toBe(200);
    expect(statusResponseSchema.parse(await status.json()).workspaceId).toBe(bridge.workspace.manifest.workspaceId);
    // No Origin, so no CORS headers: an extension with host permission for the bridge does not need them.
    expect(status.headers.get("access-control-allow-origin")).toBeNull();
    const commands = await bridge.request(`/commands?since=${encodeURIComponent("2026-09-22T09:00:00.000Z")}`, { headers: chromeGet(token) });
    expect(commands.status).toBe(200);
    expect(commandsResponseSchema.parse(await commands.json())).toEqual({ commands: [] });
    expect((await bridge.request("/status", { method: "HEAD", headers: chromeGet(token) })).status).toBe(200);
  });

  it("answers a GET with no Origin and a missing, unknown or revoked token with 401", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    await bridge.ctx.devices.revoke(deviceId);
    for (const path of ["/status", "/commands"]) {
      const missing = await bridge.request(path, { headers: chromeGet() });
      expect(missing.status, path).toBe(401);
      expect((await errorOf(missing)).code).toBe("token_missing");
      for (const bad of ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", token]) {
        const response = await bridge.request(path, { headers: chromeGet(bad) });
        expect(response.status, path).toBe(401);
        expect((await errorOf(response)).code).toBe("token_invalid");
      }
    }
  });

  it("refuses a GET whose Origin is present but not the paired one with 403", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    for (const path of ["/status", "/commands"]) {
      const response = await bridge.request(path, { headers: { ...chromeGet(token), origin: OTHER_EXTENSION_ORIGIN } });
      expect(response.status, path).toBe(403);
      expect((await errorOf(response)).code).toBe("origin_not_allowed");
    }
  });

  it("refuses a POST /events with no Origin, even on a valid token, with 403", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/events", {
      method: "POST",
      headers: { ...chromeGet(token), "content-type": "application/json" },
      body: JSON.stringify(jobCapture()),
    });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("origin_required");
    expect(await bridge.ctx.journal.list()).toHaveLength(0);
    // The same event with the paired Origin, as Chrome sends a POST, goes through.
    expect((await postEvent(bridge, token, jobCapture())).status).toBe(202);
  });
});

describe("bridge: POST /pair", () => {
  it("pairs from a chrome-extension origin and returns a contract PairResponse", async () => {
    const bridge = await makeBridge();
    const paired = await pairDevice(bridge);
    expect(paired.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [device] = await bridge.ctx.devices.list();
    expect(device?.origin).toBe(EXTENSION_ORIGIN);
  });

  it("refuses pairing from a web origin or no origin with 403", async () => {
    const bridge = await makeBridge();
    const { code } = await bridge.ctx.pairing.issue();
    for (const headers of [{ origin: "https://jobs.example" }, {}, { origin: "chrome-extension://short" }] as Array<Record<string, string>>) {
      const response = await bridge.request("/pair", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code }) });
      expect(response.status).toBe(403);
    }
    expect(await bridge.ctx.pairing.outstanding()).toBe(1);
  });

  it("answers a wrong, reused or expired code with 401", async () => {
    const bridge = await makeBridge();
    const send = (code: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin: EXTENSION_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect((await errorOf(await send("ZZZZZ-ZZZZZ"))).code).toBe("pairing_code_invalid");
    const { code } = await bridge.ctx.pairing.issue();
    expect((await send(code)).status).toBe(200);
    const reused = await send(code);
    expect(reused.status).toBe(401);
    expect((await errorOf(reused)).code).toBe("pairing_code_invalid");
    const second = await bridge.ctx.pairing.issue();
    bridge.clock.advance(10 * MINUTE_MS);
    const expired = await send(second.code);
    expect(expired.status).toBe(401);
    expect((await errorOf(expired)).code).toBe("pairing_code_expired");
  });

  it("validates the body: 400 with the zod path, 415 without JSON", async () => {
    const bridge = await makeBridge();
    const headers = { origin: EXTENSION_ORIGIN, "content-type": "application/json" };
    const empty = await bridge.request("/pair", { method: "POST", headers, body: JSON.stringify({ code: "" }) });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).issues?.[0]?.path).toEqual(["code"]);
    const extra = await bridge.request("/pair", { method: "POST", headers, body: JSON.stringify({ code: "ABCDE-FGHJK", deviceName: "x" }) });
    expect(extra.status).toBe(400);
    const tooLong = await bridge.request("/pair", { method: "POST", headers, body: JSON.stringify({ code: "A".repeat(65) }) });
    expect([400, 401]).toContain(tooLong.status);
    const text = await bridge.request("/pair", { method: "POST", headers: { origin: EXTENSION_ORIGIN, "content-type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(415);
  });

  it(`throttles after ${PAIR_FAILURE_LIMIT} wrong codes in 10 minutes with 429`, async () => {
    const bridge = await makeBridge();
    const send = (code: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin: EXTENSION_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i += 1) expect((await send("ZZZZZ-ZZZZZ")).status).toBe(401);
    const { code } = await bridge.ctx.pairing.issue();
    const throttled = await send(code);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    // A throttled attempt does not consume the code.
    expect(await bridge.ctx.pairing.outstanding()).toBe(1);
    bridge.clock.advance(10 * MINUTE_MS);
    const fresh = await bridge.ctx.pairing.issue();
    expect((await send(fresh.code)).status).toBe(200);
  });

  it("counts wrong codes per origin: another extension's failures do not block a valid code", async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < PAIR_FAILURE_LIMIT; i += 1) expect((await send(i % 2 === 0 ? "x" : "ZZZZZ-ZZZZZ", OTHER_EXTENSION_ORIGIN)).status).toBe(401);
      const { code } = await bridge.ctx.pairing.issue();
      // The failing origin is held, without using up the code...
      expect((await send(code, OTHER_EXTENSION_ORIGIN)).status).toBe(429);
      // ...and the real extension pairs with it straight away.
      expect((await send(code, EXTENSION_ORIGIN)).status).toBe(200);
      bridge.clock.advance(10 * MINUTE_MS);
    }
  });

  /** A well-formed extension origin per index: its hex digits written in Chrome's ID alphabet, a–p. */
  function extensionOrigin(index: number): string {
    const id = index
      .toString(16)
      .padStart(32, "0")
      .replace(/[0-9a-f]/g, (digit) => "abcdefghijklmnop".charAt(parseInt(digit, 16)));
    return `chrome-extension://${id}`;
  }

  const WRONG = "ZZZZZ-ZZZZZ";

  it(`lets one code absorb at most ${PAIR_CODE_GUESS_BUDGET} wrong codes, from any number of origins`, async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { code } = await bridge.ctx.pairing.issue();
    // More distinct origins than the per-origin window tracks, one wrong code each.
    let triedWhileValid = 0;
    for (let index = 1; index <= 1_100; index += 1) {
      bridge.clock.advance(1);
      if ((await bridge.ctx.pairing.outstanding()) > 0) triedWhileValid += 1;
      expect((await send(WRONG, extensionOrigin(index))).status).toBe(401);
    }
    expect(triedWhileValid).toBe(PAIR_CODE_GUESS_BUDGET);
    // The code was withdrawn: now even the right code is refused.
    const refused = await send(code, EXTENSION_ORIGIN);
    expect(refused.status).toBe(401);
    expect((await errorOf(refused)).message).toContain("withdrawn after too many wrong tries");
    // A code issued afterwards starts with a fresh budget and pairs normally.
    bridge.clock.advance(1);
    const fresh = await bridge.ctx.pairing.issue();
    expect((await send(fresh.code, EXTENSION_ORIGIN)).status).toBe(200);
  });

  it("keeps a budget per code: an older code is withdrawn while a newer one keeps its own", async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const older = await bridge.ctx.pairing.issue();
    for (let index = 1; index <= 60; index += 1) {
      bridge.clock.advance(1);
      await send(WRONG, extensionOrigin(index));
    }
    bridge.clock.advance(1);
    const newer = await bridge.ctx.pairing.issue(); // as `npm run pair` would, from another process
    for (let index = 61; index <= PAIR_CODE_GUESS_BUDGET; index += 1) {
      bridge.clock.advance(1);
      await send(WRONG, extensionOrigin(index));
    }
    // The older code absorbed 100 wrong codes, the newer only 40.
    expect(await bridge.ctx.pairing.outstanding()).toBe(1);
    expect((await send(older.code, EXTENSION_ORIGIN)).status).toBe(401);
    expect((await send(newer.code, EXTENSION_ORIGIN)).status).toBe(200);
  });

  it("refuses a malformed origin before the throttle, so it never counts against a code", async () => {
    const bridge = await makeBridge();
    const { code } = await bridge.ctx.pairing.issue();
    const malformed = [
      "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
      "chrome-extension://abcdefghijklmnopabcdefghijklmno",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnopa",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnoq",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop:443",
      "moz-extension://abcdefghijklmnopabcdefghijklmnop",
      "null",
    ];
    for (let round = 0; round < 20; round += 1) {
      for (const origin of malformed) {
        const response = await bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: WRONG }) });
        expect(response.status, origin).toBe(403);
      }
    }
    // 160 refused attempts: more than the budget, yet the code is untouched.
    expect(await bridge.ctx.pairing.outstanding()).toBe(1);
    const paired = await bridge.request("/pair", { method: "POST", headers: { origin: EXTENSION_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect(paired.status).toBe(200);
  });

  /**
   * Holds every pairing-code redeem until `release()`, like a slow disk, so
   * that a whole burst of /pair requests is in flight before any is judged.
   * `redeemed()` lists the codes in the order they were judged.
   */
  function holdRedeems(bridge: TestBridge): { release: () => Promise<void>; redeemed: () => string[] } {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const redeem = bridge.ctx.pairing.redeem.bind(bridge.ctx.pairing);
    const spy = vi.spyOn(bridge.ctx.pairing, "redeem").mockImplementation(async (input) => {
      await gate;
      return redeem(input);
    });
    return {
      // Every request sent so far reads its body first, then the gate opens.
      release: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        open();
      },
      redeemed: () => spy.mock.calls.map(([input]) => input),
    };
  }

  async function statusesOf(responses: Array<Promise<Response>>): Promise<number[]> {
    return Promise.all(responses.map(async (response) => (await response).status));
  }

  function tally(statuses: readonly number[]): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }

  it(`holds the per-code budget under concurrency: 150 wrong codes in flight use it up before the real code, sent last`, async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { code } = await bridge.ctx.pairing.issue();
    const held = holdRedeems(bridge);
    const wrong = Array.from({ length: 150 }, (_, index) => send(WRONG, extensionOrigin(index + 1)));
    const real = send(code, EXTENSION_ORIGIN);
    await held.release();
    expect(tally(await statusesOf(wrong))).toEqual({ 401: 150 });
    // The 100th wrong code withdrew the code, so the real one is refused.
    const refused = await real;
    expect(refused.status).toBe(401);
    expect((await errorOf(refused)).message).toContain("withdrawn after too many wrong tries");
    expect(await bridge.ctx.pairing.outstanding()).toBe(0);
    expect(await bridge.ctx.devices.list()).toEqual([]);
  });

  it(`holds the per-origin limit under concurrency: 30 wrong codes at once from one origin get exactly ${PAIR_FAILURE_LIMIT} × 401 and ${30 - PAIR_FAILURE_LIMIT} × 429`, async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { code } = await bridge.ctx.pairing.issue();
    const held = holdRedeems(bridge);
    const responses = Array.from({ length: 30 }, () => send(WRONG, OTHER_EXTENSION_ORIGIN));
    await held.release();
    expect(tally(await statusesOf(responses))).toEqual({ 401: PAIR_FAILURE_LIMIT, 429: 30 - PAIR_FAILURE_LIMIT });
    // Only the checked codes were tried, so the code still has budget left and pairs.
    expect(held.redeemed()).toHaveLength(PAIR_FAILURE_LIMIT);
    expect((await send(code, EXTENSION_ORIGIN)).status).toBe(200);
  });

  it("pairs a valid code racing 50 concurrent wrong codes from other origins, whether it is judged first, in the middle or last", async () => {
    // 50 wrong codes cannot use up the budget of 100, so the outcome must not
    // depend on the order: the lock only orders requests, it never refuses one.
    for (const position of [0, 25, 50]) {
      const bridge = await makeBridge();
      const send = (code: string, origin: string) =>
        bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const { code } = await bridge.ctx.pairing.issue();
      const held = holdRedeems(bridge);
      const responses: Array<Promise<Response>> = [];
      for (let index = 0; index <= 50; index += 1) {
        responses.push(index === position ? send(code, EXTENSION_ORIGIN) : send(WRONG, extensionOrigin(index + 1)));
      }
      await held.release();
      const statuses = await statusesOf(responses);
      expect(held.redeemed().indexOf(code), `judged at position ${position}`).toBe(position);
      expect(statuses[position], `valid code at position ${position}`).toBe(200);
      expect(tally(statuses.filter((_, index) => index !== position))).toEqual({ 401: 50 });
      expect((await bridge.ctx.devices.list()).map((device) => device.origin)).toEqual([EXTENSION_ORIGIN]);
    }
  });

  it("reads the body before the queue: a body still arriving holds up no other pairing request", async () => {
    const bridge = await makeBridge();
    const send = (code: string, origin: string) =>
      bridge.request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const { code } = await bridge.ctx.pairing.issue();
    const encoder = new TextEncoder();
    let finish: () => void = () => undefined;
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"code":'));
        finish = () => {
          controller.enqueue(encoder.encode(JSON.stringify(WRONG) + "}"));
          controller.close();
        };
      },
    });
    const slow = bridge.request("/pair", {
      method: "POST",
      headers: { origin: OTHER_EXTENSION_ORIGIN, "content-type": "application/json" },
      body: trickle,
      duplex: "half",
    } as RequestInit & { headers: Record<string, string> });
    // While that body is still arriving, the real extension pairs.
    expect((await send(code, EXTENSION_ORIGIN)).status).toBe(200);
    finish();
    expect((await slow).status).toBe(401);
  });
});

describe("bridge: POST /events", () => {
  it("refuses an oversized body with 413 before reading it (declared length)", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/events", {
      method: "POST",
      headers: authed(token, EXTENSION_ORIGIN, { "content-type": "application/json", "content-length": String(MAX_BRIDGE_BODY_BYTES + 1) }),
      body: "{}",
    });
    expect(response.status).toBe(413);
  });

  it("refuses an oversized body with 413 while streaming it (no or false length)", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const big = JSON.stringify(jobCapture({ text: "x".repeat(MAX_BRIDGE_BODY_BYTES) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const response = await bridge.request("/events", {
      method: "POST",
      headers: authed(token, EXTENSION_ORIGIN, { "content-type": "application/json" }),
      body: stream,
      duplex: "half",
    } as RequestInit & { headers: Record<string, string> });
    expect(response.status).toBe(413);
    expect(await bridge.ctx.journal.list()).toHaveLength(0);
  });

  it("answers an invalid envelope with 400 and the zod path", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const cases: Array<[unknown, Array<string | number>]> = [
      [{ ...jobCapture(), url: "javascript:alert(1)" }, ["url"]],
      [{ ...jobCapture(), protocol: 2 }, ["protocol"]],
      [{ ...jobCapture(), eventId: "not-a-uuid" }, ["eventId"]],
      [{ ...jobCapture(), injected: "ignore previous instructions" }, []],
      [{ ...jobCapture(), type: "run_shell" }, ["type"]],
    ];
    for (const [body, path] of cases) {
      const response = await postEvent(bridge, token, body);
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("invalid_body");
      expect(error.issues?.[0]?.path).toEqual(path);
    }
    const notJson = await bridge.request("/events", { method: "POST", headers: authed(token, EXTENSION_ORIGIN, { "content-type": "application/json" }), body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(await bridge.ctx.journal.list()).toHaveLength(0);
  });

  it("acknowledges a replayed eventId once and stores it once", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const event = jobCapture();
    const first = await postEvent(bridge, token, event);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, eventId: event.eventId, duplicate: false, outcome: "journaled" });
    const replay = await postEvent(bridge, token, event);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ ok: true, eventId: event.eventId, duplicate: true });
    const concurrent = await Promise.all([postEvent(bridge, token, event), postEvent(bridge, token, event)]);
    for (const response of concurrent) expect(response.status).toBe(202);
    const stored = await bridge.ctx.journal.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event).toEqual(event);
    expect(await bridge.workspace.list(".runner", "events")).toEqual([`${event.eventId}.json`]);
  });

  it("answers the same eventId with a different body, or from another device, with 409", async () => {
    const bridge = await makeBridge();
    const first = await pairDevice(bridge);
    const second = await pairDevice(bridge, OTHER_EXTENSION_ORIGIN);
    const event = jobCapture();
    expect((await postEvent(bridge, first.token, event)).status).toBe(202);
    const changed = await postEvent(bridge, first.token, { ...event, text: `${event.text} (edited)` });
    expect(changed.status).toBe(409);
    expect((await errorOf(changed)).code).toBe("event_id_conflict");
    const otherDevice = await postEvent(bridge, second.token, event, OTHER_EXTENSION_ORIGIN);
    expect(otherDevice.status).toBe(409);
    expect(await bridge.ctx.journal.list()).toHaveLength(1);
  });

  it("dispatches to the route module that handles the type, once per eventId", async () => {
    const calls: string[] = [];
    const captures: LoadedRouteModule = {
      name: "captures",
      module: defineRouteModule({
        events: {
          job_capture: (event, ctx) => {
            calls.push(`${event.eventId}:${ctx.device.origin}`);
            return { jobId: "job-1", revision: 1 };
          },
        },
      }),
    };
    const bridge = await makeBridge({ modules: [captures] });
    const { token } = await pairDevice(bridge);
    const event = jobCapture();
    const first = await postEvent(bridge, token, event);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, outcome: "handled", duplicate: false, result: { jobId: "job-1", revision: 1 } });
    const replay = await postEvent(bridge, token, event);
    expect(await replay.json()).toMatchObject({ ok: true, outcome: "handled", duplicate: true, result: { jobId: "job-1" } });
    expect(calls).toEqual([`${event.eventId}:${EXTENSION_ORIGIN}`]);
    expect((await bridge.ctx.journal.get(event.eventId))?.dispatch).toMatchObject({ status: "handled", handler: "captures" });
  });

  it("returns a handler's rejection (a stale revision is 409) and replays it without re-running", async () => {
    let runs = 0;
    const applications: LoadedRouteModule = {
      name: "applications",
      module: defineRouteModule({
        events: {
          application_status_changed: () => {
            runs += 1;
            throw new EventRejectedError(409, "stale_revision", "The application changed since the extension last saw it.");
          },
        },
      }),
    };
    const bridge = await makeBridge({ modules: [applications] });
    const { token } = await pairDevice(bridge);
    const event = {
      protocol: 1,
      type: "application_status_changed",
      eventId: randomUUID(),
      taskId: randomUUID(),
      expectedRevision: 3,
      status: "applied",
      occurredAt: "2026-09-22T09:00:00.000Z",
    };
    const response = await postEvent(bridge, token, event);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("stale_revision");
    expect((await postEvent(bridge, token, event)).status).toBe(409);
    expect(runs).toBe(1);
  });

  it("answers an unexpected handler error with 500 and runs the handler again on retry", async () => {
    let runs = 0;
    const flaky: LoadedRouteModule = {
      name: "captures",
      module: defineRouteModule({
        events: {
          job_capture: () => {
            runs += 1;
            if (runs === 1) throw new Error("disk full");
            return { ok: true };
          },
        },
      }),
    };
    const bridge = await makeBridge({ modules: [flaky] });
    const { token } = await pairDevice(bridge);
    const event = jobCapture();
    expect((await postEvent(bridge, token, event)).status).toBe(500);
    const retry = await postEvent(bridge, token, event);
    expect(retry.status).toBe(200);
    expect(runs).toBe(2);
    expect((await bridge.ctx.journal.get(event.eventId))?.attempts).toBe(2);
    expect(bridge.logs.join("\n")).not.toContain(event.text);
  });

  it("refuses two modules handling the same event type at startup", async () => {
    const one = { name: "a", module: defineRouteModule({ events: { job_capture: () => undefined } }) };
    const two = { name: "b", module: defineRouteModule({ events: { job_capture: () => undefined } }) };
    await expect(makeBridge({ modules: [one, two] })).rejects.toThrow(/Exactly one module may/);
  });
});

describe("bridge: GET /commands", () => {
  function command(deviceId: string, overrides: Partial<OpenApplicationGroup> = {}): OpenApplicationGroup {
    return {
      protocol: 1,
      type: "open_application_group",
      commandId: randomUUID(),
      deviceId,
      sessionId: randomUUID(),
      workflowVersion: "job-assistant@0",
      expiresAt: "2026-09-22T10:00:00.000Z",
      payload: { title: "Northwind Labs application", items: [{ taskId: randomUUID(), jobRevision: 1, url: "https://jobs.example/northwind-labs/apply" }] },
      ...overrides,
    };
  }

  it("returns an empty, contract-valid list when nothing is queued", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/commands", { headers: authed(token) });
    expect(response.status).toBe(200);
    expect(commandsResponseSchema.parse(await response.json())).toEqual({ commands: [] });
  });

  it("delivers only the device's own pending commands, leased", async () => {
    const bridge = await makeBridge();
    const mine = await pairDevice(bridge);
    const theirs = await pairDevice(bridge, OTHER_EXTENSION_ORIGIN);
    const ours = command(mine.deviceId);
    await bridge.ctx.commands.enqueue(ours);
    await bridge.ctx.commands.enqueue(command(theirs.deviceId));
    await bridge.ctx.commands.enqueue(command(mine.deviceId, { expiresAt: "2026-09-22T08:00:00.000Z" }));
    const first = commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(mine.token) })).json());
    expect(first.commands.map((c) => c.commandId)).toEqual([ours.commandId]);
    const leased = commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(mine.token) })).json());
    expect(leased.commands).toEqual([]);
    bridge.clock.advance(5 * MINUTE_MS);
    const again = commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(mine.token) })).json());
    expect(again.commands.map((c) => c.commandId)).toEqual([ours.commandId]);
    expect(await bridge.ctx.commands.acknowledge(ours.commandId, mine.deviceId)).toBe(true);
    bridge.clock.advance(5 * MINUTE_MS);
    expect(commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(mine.token) })).json()).commands).toEqual([]);
  });

  it("re-delivers a command whose lease lapsed unacknowledged, whatever since says", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    const ours = command(deviceId);
    await bridge.ctx.commands.enqueue(ours); // created 09:00
    const poll = async (since: string) =>
      commandsResponseSchema
        .parse(await (await bridge.request(`/commands?since=${encodeURIComponent(since)}`, { headers: authed(token) })).json())
        .commands.map((c) => c.commandId);
    bridge.clock.advance(1 * MINUTE_MS); // 09:01
    expect(await poll("2026-09-22T09:00:00.000Z")).toEqual([ours.commandId]);
    // The worker dies before acknowledging. The lease lapses at 09:06.
    bridge.clock.advance(15 * MINUTE_MS); // 09:16, polling with its last poll time
    expect(await poll("2026-09-22T09:01:00.000Z")).toEqual([ours.commandId]);
    expect((await bridge.ctx.commands.get(ours.commandId))?.deliveries).toBe(2);
  });

  it("applies since only to commands never delivered", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    const early = command(deviceId);
    await bridge.ctx.commands.enqueue(early); // created 09:00
    bridge.clock.advance(2 * MINUTE_MS);
    const late = command(deviceId);
    await bridge.ctx.commands.enqueue(late); // created 09:02
    const since = encodeURIComponent("2026-09-22T09:01:00.000Z");
    const narrowed = commandsResponseSchema.parse(await (await bridge.request(`/commands?since=${since}`, { headers: authed(token) })).json());
    expect(narrowed.commands.map((c) => c.commandId)).toEqual([late.commandId]);
    const all = commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(token) })).json());
    expect(all.commands.map((c) => c.commandId)).toEqual([early.commandId]);
  });

  it("answers HEAD like GET but leases nothing", async () => {
    const bridge = await makeBridge();
    const { deviceId, token } = await pairDevice(bridge);
    const ours = command(deviceId);
    await bridge.ctx.commands.enqueue(ours);
    const head = await bridge.request("/commands", { method: "HEAD", headers: authed(token) });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const untouched = await bridge.ctx.commands.get(ours.commandId);
    expect(untouched?.deliveries).toBe(0);
    expect(untouched?.lease).toBeUndefined();
    // HEAD is authenticated and validated like GET.
    expect((await bridge.request("/commands", { method: "HEAD" })).status).toBe(401);
    expect((await bridge.request("/commands?since=yesterday", { method: "HEAD", headers: authed(token) })).status).toBe(400);
    // So the next GET delivers the command at once, not 5 minutes later.
    const polled = commandsResponseSchema.parse(await (await bridge.request("/commands", { headers: authed(token) })).json());
    expect(polled.commands.map((c) => c.commandId)).toEqual([ours.commandId]);
    expect((await bridge.ctx.commands.get(ours.commandId))?.deliveries).toBe(1);
  });

  it("validates since: 400 with path [since] for a bad value or an unknown parameter", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const bad = await bridge.request("/commands?since=yesterday", { headers: authed(token) });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).issues?.[0]?.path).toEqual(["since"]);
    const unknown = await bridge.request("/commands?limit=5", { headers: authed(token) });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).issues?.[0]?.path).toEqual(["limit"]);
    const ok = await bridge.request(`/commands?since=${encodeURIComponent("2026-09-22T09:00:00.000Z")}`, { headers: authed(token) });
    expect(ok.status).toBe(200);
  });
});

describe("bridge: GET /status", () => {
  it("returns a contract StatusResponse with no personal data", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: authed(token) });
    expect(response.status).toBe(200);
    const status = statusResponseSchema.parse(await response.json());
    expect(status).toEqual({
      version: "0.1.0",
      workspaceId: bridge.workspace.manifest.workspaceId,
      budget: { dailyRunLimit: 0, runsUsedToday: 0, paused: false },
      schedules: [],
    });
    expect(JSON.stringify(status)).not.toContain(bridge.workspace.root);
  });

  it("includes budget and schedules contributed by route modules", async () => {
    const runs: LoadedRouteModule = {
      name: "runs",
      module: defineRouteModule({
        status: () => ({
          budget: { dailyRunLimit: 20, runsUsedToday: 3, paused: false },
          schedules: [{ id: "prepare-new-jobs", kind: "prepare_newly_saved_jobs", paused: false, nextRunAt: "2026-09-23T07:00:00.000Z" }],
        }),
      }),
    };
    const bridge = await makeBridge({ modules: [runs] });
    const { token } = await pairDevice(bridge);
    const status = statusResponseSchema.parse(await (await bridge.request("/status", { headers: authed(token) })).json());
    expect(status.budget.dailyRunLimit).toBe(20);
    expect(status.schedules).toHaveLength(1);
  });
});

describe("bridge: CORS", () => {
  it("answers a preflight from the paired origin and refuses others", async () => {
    const bridge = await makeBridge();
    await pairDevice(bridge);
    const preflight = (path: string, origin: string) =>
      bridge.request(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    const ok = await preflight("/status", EXTENSION_ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    for (const origin of [OTHER_EXTENSION_ORIGIN, "https://jobs.example"]) {
      const refused = await preflight("/status", origin);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
    const pair = await preflight("/pair", OTHER_EXTENSION_ORIGIN);
    expect(pair.status).toBe(204);
    expect((await preflight("/pair", "https://jobs.example")).status).toBe(403);
  });

  it("never sends CORS headers to a web origin", async () => {
    const bridge = await makeBridge();
    const { token } = await pairDevice(bridge);
    const response = await bridge.request("/status", { headers: authed(token, "https://jobs.example") });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await bridge.request("/status", { headers: authed(token) });
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
  });
});
