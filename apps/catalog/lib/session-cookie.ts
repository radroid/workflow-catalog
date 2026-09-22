// Pure crypto + cookie shape for the friend-facing session cookie. No DB
// import here on purpose: this module is safe to import from proxy.ts (the
// "optimistic cookie-signature check" layer), which must stay lightweight
// and must never pull in a database driver. The second, DB-backed layer
// (does this session still exist and is it unrevoked?) lives in
// lib/auth/require-session.ts and is used everywhere else.

import { getSessionSecret } from "./auth-config";
import { hmacSign, hmacVerify } from "./crypto";

export const SESSION_COOKIE = "session";

export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days; revocation is what actually ends a session.

function signedMessage(sessionId: string): string {
  // Domain-separated from the owner cookie's signed message (see
  // owner-cookie.ts), even though both currently sign with SESSION_SECRET,
  // so a valid owner-cookie value can never be replayed as a session cookie
  // or vice versa.
  return `session:${sessionId}`;
}

/** Builds the `session` cookie value: `<sessionId>.<hmac>`. */
export async function createSessionCookieValue(sessionId: string): Promise<string> {
  const secret = getSessionSecret();
  const signature = await hmacSign(secret, signedMessage(sessionId));
  return `${sessionId}.${signature}`;
}

/**
 * The optimistic layer: verifies the cookie's signature only, no database
 * call. Returns the session id on success. Fails closed (returns null) if
 * SESSION_SECRET is unset, the cookie is missing, malformed, or the
 * signature does not verify — it never throws, so proxy.ts can call it
 * unconditionally on every request.
 */
export async function verifySessionCookie(raw: string | undefined | null): Promise<{ sessionId: string } | null> {
  if (!raw) return null;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const sessionId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  const ok = await hmacVerify(secret, signedMessage(sessionId), signature);
  return ok ? { sessionId } : null;
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}
