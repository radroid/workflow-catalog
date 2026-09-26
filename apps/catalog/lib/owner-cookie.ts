// Pure crypto + cookie shape for the owner's `/admin` gate. No database
// table backs this: the cookie carries its own issued-at timestamp and a
// ≤12h expiry is enforced by checking that timestamp on every verify, not
// by a session row (unlike the friend session cookie, which is also
// checked against `sessions.revoked_at` — see lib/auth/require-session.ts).

import { getSessionSecret } from "./auth-config";
import { hmacSign, hmacVerify } from "./crypto";

export const OWNER_COOKIE = "owner_session";

export const OWNER_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60; // spec: expiry ≤ 12h.

function signedMessage(issuedAtSeconds: number): string {
  // Domain-separated from the friend session cookie's signed message (see
  // session-cookie.ts) so the two cookie kinds can never be replayed as
  // each other, even though both are signed with SESSION_SECRET today.
  return `owner:${issuedAtSeconds}`;
}

/** Builds the `owner_session` cookie value: `<issuedAtSeconds>.<hmac>`. */
export async function createOwnerCookieValue(): Promise<string> {
  const secret = getSessionSecret();
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await hmacSign(secret, signedMessage(issuedAt));
  return `${issuedAt}.${signature}`;
}

/**
 * Verifies the owner cookie's signature and its ≤12h age. Fails closed
 * (returns false) if SESSION_SECRET is unset, the cookie is missing or
 * malformed, the signature does not verify, or it has expired.
 */
export async function verifyOwnerCookieValue(raw: string | undefined | null): Promise<boolean> {
  if (!raw) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return false;
  const issuedAtRaw = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;

  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSeconds < 0 || ageSeconds > OWNER_COOKIE_MAX_AGE_SECONDS) return false;

  return hmacVerify(secret, signedMessage(issuedAt), signature);
}

export interface OwnerCookieOptions {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function ownerCookieOptions(): OwnerCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
  };
}
