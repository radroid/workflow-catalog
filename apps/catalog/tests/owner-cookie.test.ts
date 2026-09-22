import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerCookieValue, OWNER_COOKIE_MAX_AGE_SECONDS, verifyOwnerCookieValue } from "../lib/owner-cookie";

describe("owner cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("verifies a cookie it created itself", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createOwnerCookieValue();
    expect(await verifyOwnerCookieValue(value)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createOwnerCookieValue();

    // Flip the character right after the "." (the first character of the
    // base64url-encoded HMAC-SHA256 signature), not the value's last
    // character. A 32-byte signature isn't a multiple of 3 bytes, so
    // base64's final character encodes 4 real bits plus 2 "don't care"
    // padding bits (always 0 in a canonical encoding, but atob() decodes
    // them leniently) — some specific last-character substitutions
    // therefore decode to the *same* signature bytes, making
    // hmacVerify() correctly return true for a value this test only
    // thought it had tampered with. That's what made this test flaky:
    // it depends on which character `hmacSign` happened to produce for a
    // given (time-dependent) run, not on any bug in hmacVerify. The first
    // character of a base64 block is never partial — flipping it always
    // changes the decoded bytes.
    const dot = value.indexOf(".");
    const signatureFirstChar = value[dot + 1];
    const flipped = signatureFirstChar === "A" ? "B" : "A";
    const tampered = value.slice(0, dot + 1) + flipped + value.slice(dot + 2);

    expect(await verifyOwnerCookieValue(tampered)).toBe(false);
  });

  it("rejects a cookie signed under a different SESSION_SECRET", async () => {
    vi.stubEnv("SESSION_SECRET", "secret-one");
    const value = await createOwnerCookieValue();

    vi.stubEnv("SESSION_SECRET", "secret-two");
    expect(await verifyOwnerCookieValue(value)).toBe(false);
  });

  it("rejects missing or malformed cookies without throwing", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    expect(await verifyOwnerCookieValue(undefined)).toBe(false);
    expect(await verifyOwnerCookieValue("")).toBe(false);
    expect(await verifyOwnerCookieValue("no-dot-here")).toBe(false);
    expect(await verifyOwnerCookieValue("not-a-number.sig")).toBe(false);
  });

  it("expires once older than the max age (spec: expiry <=12h)", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const value = await createOwnerCookieValue();
    expect(await verifyOwnerCookieValue(value)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + (OWNER_COOKIE_MAX_AGE_SECONDS - 1) * 1000));
    expect(await verifyOwnerCookieValue(value)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + 2 * 1000));
    expect(await verifyOwnerCookieValue(value)).toBe(false);
  });

  it("fails closed when SESSION_SECRET is unset", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const value = await createOwnerCookieValue();

    vi.stubEnv("SESSION_SECRET", "");
    expect(await verifyOwnerCookieValue(value)).toBe(false);
  });
});
