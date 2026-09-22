import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db";
import { findActiveSession, type ActiveSession } from "../sessions";
import { SESSION_COOKIE, verifySessionCookie } from "../session-cookie";

/**
 * The second layer of the two-layer session check, given a raw cookie value
 * however the caller obtained it: re-verifies the signature and then asks
 * the database whether the session still exists, is unrevoked, and
 * unexpired. Never throws; returns null on any failure so callers decide
 * how to respond.
 */
async function loadActiveSession(raw: string | undefined): Promise<ActiveSession | null> {
  const parsed = await verifySessionCookie(raw);
  if (!parsed) return null;

  const db = await getDb();
  return findActiveSession(db, parsed.sessionId);
}

/**
 * For Server Components (layouts, pages): reads the cookie via
 * `next/headers`'s `cookies()`, which only works inside Next's own
 * request-rendering context. Wrapped in React's `cache()` (request
 * memoization): the gated layout and the page it wraps both call this, and
 * within one request it only hits the database once.
 */
export const getActiveSession = cache(async (): Promise<ActiveSession | null> => {
  const store = await cookies();
  return loadActiveSession(store.get(SESSION_COOKIE)?.value);
});

/**
 * For Route Handlers (see app/(gated)/learn/[...slug]/route.ts): Route
 * Handlers receive the request directly and don't participate in React
 * Server Component rendering, so they read the cookie off the request they
 * were given (`NextRequest#cookies`, parsed straight from headers, no
 * ambient context needed) rather than call `next/headers`'s `cookies()`.
 *
 * This used to call the `cache()`-wrapped `getActiveSession` above directly
 * — every request 500'd with "cookies was called outside a request scope",
 * because `cache()` memoization is keyed to an active React render, and a
 * Route Handler invocation is not one (the crash happened before the
 * handler's own 404/redirect logic ever ran, which is why a missing file
 * and a revoked session both 500'd too, instead of 404ing/redirecting).
 * This function has no such dependency, which also makes it directly
 * unit-testable (see tests/learn-route.test.ts) without needing Next's
 * server runtime.
 */
export async function getActiveSessionFromCookieValue(raw: string | undefined): Promise<ActiveSession | null> {
  return loadActiveSession(raw);
}

/**
 * For Server Components (layouts, pages) only — route handlers don't
 * participate in layouts and must call `getActiveSessionFromCookieValue`
 * directly and respond with `NextResponse.redirect` themselves (see
 * app/(gated)/learn/[...slug]/route.ts).
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getActiveSession();
  if (!session) {
    redirect("/");
  }
  return session;
}
