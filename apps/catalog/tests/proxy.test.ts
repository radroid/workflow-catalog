import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { createSessionCookieValue } from "../lib/session-cookie";

const BASE = "http://localhost:3103";

function requestFor(path: string, cookieHeader?: string): NextRequest {
  // No explicit `RequestInit`-typed variable here on purpose: the DOM lib's
  // RequestInit types `signal` as `AbortSignal | null | undefined`, which is
  // wider than what NextRequest's own constructor type accepts — passing an
  // object literal directly lets TypeScript check it structurally against
  // NextRequest's actual (narrower) init type instead.
  return new NextRequest(new URL(path, BASE), cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
}

// Layer 1 of the two-layer session check — see proxy.ts's header comment.
// This never touches a database; it only exercises the cookie-signature
// check, which is exactly what proxy.ts is for.
describe("proxy — layer 1 (optimistic cookie signature check)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets every public path through with no cookie at all", async () => {
    for (const path of ["/", "/admin", "/invite/abc123", "/invite/"]) {
      const res = await proxy(requestFor(path));
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("redirects every non-public path to / without a session cookie", async () => {
    for (const path of ["/install", "/learn", "/learn/lessons/0001.html", "/something-unknown"]) {
      const res = await proxy(requestFor(path));
      expect(res.headers.get("location")).toBe(`${BASE}/`);
    }
  });

  it("redirects a gated path when the cookie is present but does not verify", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const res = await proxy(requestFor("/install", "session=not-a-real-cookie.garbage"));
    expect(res.headers.get("location")).toBe(`${BASE}/`);
  });

  it("redirects a gated path when SESSION_SECRET is unset, even with an otherwise-valid-shaped cookie", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const cookieValue = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");

    vi.stubEnv("SESSION_SECRET", "");
    const res = await proxy(requestFor("/install", `session=${cookieValue}`));
    expect(res.headers.get("location")).toBe(`${BASE}/`);
  });

  it("lets a gated path through when the session cookie verifies", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const cookieValue = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");
    const res = await proxy(requestFor("/install", `session=${cookieValue}`));
    expect(res.headers.get("location")).toBeNull();
  });
});
