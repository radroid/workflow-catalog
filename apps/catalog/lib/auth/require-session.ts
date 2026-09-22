import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db";
import { findActiveSession, type ActiveSession } from "../sessions";
import { SESSION_COOKIE, verifySessionCookie } from "../session-cookie";

/**
 * The second layer of the two-layer session check. `proxy.ts` already did
 * the optimistic signature-only check before this ever runs (for pages —
 * route handlers below get no help from proxy's redirect and must call this
 * directly), but this layer re-verifies the signature anyway and then asks
 * the database whether the session still exists and is unrevoked. Never
 * throws; returns null on any failure so callers decide how to respond.
 *
 * Wrapped in React's `cache()` (request memoization): the gated layout and
 * the page it wraps both call this, and within one request it only hits the
 * database once.
 */
export const getActiveSession = cache(async (): Promise<ActiveSession | null> => {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  const parsed = await verifySessionCookie(raw);
  if (!parsed) return null;

  const db = await getDb();
  return findActiveSession(db, parsed.sessionId);
});

/**
 * For Server Components (layouts, pages) only — route handlers don't
 * participate in layouts and must call `getActiveSession` directly and
 * respond with `NextResponse.redirect` themselves (see
 * app/(gated)/learn/[...slug]/route.ts).
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getActiveSession();
  if (!session) {
    redirect("/");
  }
  return session;
}
