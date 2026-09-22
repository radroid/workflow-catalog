import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { acceptInvite, createInvite } from "../lib/invites";
import { findActiveSession, revokeSession } from "../lib/sessions";
import { createSessionCookieValue, SESSION_COOKIE_MAX_AGE_SECONDS, verifySessionCookie } from "../lib/session-cookie";
import { toIsoString } from "../lib/db/format";

async function acceptedSession(db: Awaited<ReturnType<typeof createTestDb>>) {
  const created = await createInvite(db);
  if (!created.ok) throw new Error("test setup: createInvite failed");
  const accepted = await acceptInvite(db, created.token, "Ada Quill");
  if (!accepted.ok) throw new Error("test setup: acceptInvite failed");
  return accepted;
}

// This is "layer 2" of the two-layer session check that every gated
// layout/route performs (see lib/auth/require-session.ts — its
// getActiveSession is exactly: verify the cookie signature, then call
// findActiveSession). findActiveSession is tested directly here because it
// has no dependency on Next's request context, unlike getActiveSession
// itself (which reads next/headers's cookies()); the request-context glue
// is exercised for real by the screenshot walkthrough in the PR.
describe("gated-layout database check (session revocation)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds an active session right after accepting an invite", async () => {
    const db = await createTestDb();
    const { sessionId } = await acceptedSession(db);

    const active = await findActiveSession(db, sessionId);
    expect(active).toEqual({ id: sessionId, displayName: "Ada Quill" });
  });

  it("refuses a revoked session even though its signed cookie still verifies", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    const db = await createTestDb();
    const { sessionId } = await acceptedSession(db);

    const cookieValue = await createSessionCookieValue(sessionId);

    await revokeSession(db, sessionId);

    // Layer 1 (signature-only, what proxy.ts checks) still passes: nothing
    // about the cookie itself changed.
    expect(await verifySessionCookie(cookieValue)).toEqual({ sessionId });

    // Layer 2 (the database check) is what actually catches the revocation.
    expect(await findActiveSession(db, sessionId)).toBeNull();
  });

  it("returns null for an unknown session id", async () => {
    const db = await createTestDb();
    expect(await findActiveSession(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("revokeSession is idempotent", async () => {
    const db = await createTestDb();
    const { sessionId } = await acceptedSession(db);

    await revokeSession(db, sessionId);
    await revokeSession(db, sessionId); // must not throw or un-revoke.

    expect(await findActiveSession(db, sessionId)).toBeNull();
  });

  it("a freshly accepted session has an expires_at roughly SESSION_COOKIE_MAX_AGE_SECONDS out", async () => {
    const db = await createTestDb();
    const before = Date.now();
    const { sessionId } = await acceptedSession(db);
    const after = Date.now();

    const { rows } = await db.query<{ expires_at: unknown }>("SELECT expires_at FROM sessions WHERE id = $1", [
      sessionId,
    ]);
    const expiresAtMs = new Date(toIsoString(rows[0]?.expires_at)).getTime();

    expect(expiresAtMs).toBeGreaterThanOrEqual(before + SESSION_COOKIE_MAX_AGE_SECONDS * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + SESSION_COOKIE_MAX_AGE_SECONDS * 1000 + 1000);
  });

  it("refuses an expired session even though it was never revoked", async () => {
    // expires_at is computed in application code (Date.now(), not SQL
    // now()), so it can't be back-dated with vi.useFakeTimers() — PGlite's
    // own now() (used in the query's WHERE clause) runs inside its WASM
    // Postgres engine and doesn't observe a mocked JS clock. Back-dating
    // the stored value directly exercises the same WHERE clause a real
    // 30-days-later request would hit.
    const db = await createTestDb();
    const { sessionId } = await acceptedSession(db);
    expect(await findActiveSession(db, sessionId)).not.toBeNull();

    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [sessionId]);

    expect(await findActiveSession(db, sessionId)).toBeNull();
  });
});
