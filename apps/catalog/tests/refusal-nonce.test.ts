import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerSignInAction } from "../lib/actions/owner";
import { acceptInviteAction } from "../lib/actions/invite";

// P09-B peer review, round 2 (low follow-up #1): "Nothing tests that the
// refusal actions add a fresh nonce." lib/actions/owner.ts's adminError and
// lib/actions/invite.ts's refused both append `&n=${crypto.randomUUID()}`
// to the redirect URL, purely so two consecutive *identical* refusals (e.g.
// the wrong secret twice in a row) land on two different URLs —
// tests/error-alert-remount.test.tsx already proves that a changed `key`
// forces <ErrorAlert> to remount and refocus, but nothing until now proved
// the action functions actually mint that changed key on every call. These
// tests call the real Server Actions directly and inspect the redirect
// target itself, so removing `&n=...` from either action (leaving two
// identical refusals producing the exact same URL) fails a test here.
//
// next/navigation's redirect() throws a plain Error (not a rejection tied
// to any Next.js request context) whose `.digest` encodes
// "NEXT_REDIRECT;<type>;<url>;<statusCode>;" — confirmed by calling it
// directly under plain Node/Vitest, no Next server involved. That makes it
// callable here without mocking next/navigation at all.
function redirectUrl(error: unknown): string {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) {
    throw error instanceof Error ? error : new Error(`expected a NEXT_REDIRECT digest, got ${String(error)}`);
  }
  const url = digest.split(";")[2];
  if (url === undefined) throw new Error(`malformed NEXT_REDIRECT digest: ${digest}`);
  return url;
}

async function captureRedirect(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return redirectUrl(error);
  }
  throw new Error("expected the action to redirect (throw NEXT_REDIRECT), but it returned normally");
}

function nonceOf(url: string): string | null {
  return new URL(url, "http://localhost").searchParams.get("n");
}

// crypto.randomUUID()'s own format — matching it (rather than just "is a
// non-empty string") is what makes removing `&n=...` entirely fail this
// test: URLSearchParams#get returns null for an absent param, and null
// never matches this pattern.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("refusal actions mint a fresh nonce on every redirect", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ownerSignInAction: two wrong-secret refusals in a row redirect with two different n values", async () => {
    vi.stubEnv("OWNER_SECRET", "the-real-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");

    function wrongSecretForm(): FormData {
      const formData = new FormData();
      formData.set("secret", "not-the-real-secret");
      return formData;
    }

    const firstUrl = await captureRedirect(() => ownerSignInAction(wrongSecretForm()));
    const secondUrl = await captureRedirect(() => ownerSignInAction(wrongSecretForm()));

    expect(firstUrl).toMatch(/^\/admin\?error=wrong_secret&n=/);
    expect(secondUrl).toMatch(/^\/admin\?error=wrong_secret&n=/);

    const firstNonce = nonceOf(firstUrl);
    const secondNonce = nonceOf(secondUrl);
    expect(firstNonce).toMatch(UUID_PATTERN);
    expect(secondNonce).toMatch(UUID_PATTERN);
    expect(firstNonce).not.toBe(secondNonce);
  });

  it("acceptInviteAction: two missing-token refusals in a row redirect with two different n values", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");

    function missingTokenForm(): FormData {
      // No "token" field set at all, and no "token" route param passed to
      // the action either (String(formData.get("token") ?? "") -> "") —
      // the same "missing_token" refusal path either way, and it needs no
      // database, unlike an "invalid_token" refusal would.
      return new FormData();
    }

    const firstUrl = await captureRedirect(() => acceptInviteAction(missingTokenForm()));
    const secondUrl = await captureRedirect(() => acceptInviteAction(missingTokenForm()));

    expect(firstUrl).toMatch(/^\/invite\/\?error=missing_token&n=/);
    expect(secondUrl).toMatch(/^\/invite\/\?error=missing_token&n=/);

    const firstNonce = nonceOf(firstUrl);
    const secondNonce = nonceOf(secondUrl);
    expect(firstNonce).toMatch(UUID_PATTERN);
    expect(secondNonce).toMatch(UUID_PATTERN);
    expect(firstNonce).not.toBe(secondNonce);
  });
});
