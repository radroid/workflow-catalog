import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { acceptInvite, createInvite } from "../lib/invites";
import { findActiveSession, revokeSession } from "../lib/sessions";
import { createSessionCookieValue, verifySessionCookie } from "../lib/session-cookie";

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
});
