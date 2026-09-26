import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCookieValue, verifySessionCookie } from "../lib/session-cookie";

describe("session cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies a cookie it created itself", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");
    const result = await verifySessionCookie(value);
    expect(result).toEqual({ sessionId: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects a tampered session id (cookie cut-and-pasted onto a different id)", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");
    const dot = value.lastIndexOf(".");
    const signature = value.slice(dot + 1);
    const tampered = `22222222-2222-4222-8222-222222222222.${signature}`;
    expect(await verifySessionCookie(tampered)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");
    const tampered = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
    expect(await verifySessionCookie(tampered)).toBeNull();
  });

  it("rejects a cookie signed under a different SESSION_SECRET", async () => {
    vi.stubEnv("SESSION_SECRET", "secret-one");
    const value = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");

    vi.stubEnv("SESSION_SECRET", "secret-two");
    expect(await verifySessionCookie(value)).toBeNull();
  });

  it("rejects missing or malformed cookies without throwing", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    expect(await verifySessionCookie(undefined)).toBeNull();
    expect(await verifySessionCookie(null)).toBeNull();
    expect(await verifySessionCookie("")).toBeNull();
    expect(await verifySessionCookie("no-dot-in-here")).toBeNull();
    expect(await verifySessionCookie("trailing-dot.")).toBeNull();
  });

  it("fails closed when SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createSessionCookieValue("11111111-1111-4111-8111-111111111111");

    vi.stubEnv("SESSION_SECRET", ""); // "" is falsy, same as unset for the `if (!secret)` guard this exercises.
    expect(await verifySessionCookie(value)).toBeNull();
  });
});
