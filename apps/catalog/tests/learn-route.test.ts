import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../app/(gated)/learn/[...slug]/route";
import { getDb, resetDbCacheForTests } from "../lib/db";
import { acceptInvite, createInvite } from "../lib/invites";
import { revokeSession } from "../lib/sessions";
import { createSessionCookieValue } from "../lib/session-cookie";

const BASE = "http://localhost:3103";

function requestFor(pathname: string, cookieHeader?: string): NextRequest {
  return new NextRequest(new URL(pathname, BASE), cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
}

function contextFor(slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

// Regression coverage for a bug found in a live walkthrough: every request
// here used to 500 with "cookies was called outside a request scope" (see
// lib/auth/require-session.ts's getActiveSessionFromCookieValue comment),
// because the crash happened before this handler's own 404/redirect logic
// ever ran. Goes through the real getDb() singleton (not the in-memory
// createTestDb() helper) precisely to exercise the route handler as Next
// actually calls it — no db parameter is available to inject.
describe("/learn/[...slug] route handler", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "wc-catalog-learn-route-"));
    vi.stubEnv("CATALOG_PGLITE_DIR", dataDir);
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    resetDbCacheForTests();
  });

  afterEach(() => {
    resetDbCacheForTests();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function acceptedSession() {
    const db = await getDb();
    const created = await createInvite(db);
    if (!created.ok) throw new Error("test setup: createInvite failed");
    const accepted = await acceptInvite(db, created.token, "Ada Quill");
    if (!accepted.ok) throw new Error("test setup: acceptInvite failed");
    return accepted;
  }

  it("serves a real lesson with the right content-type for a signed-in user", async () => {
    const { sessionId } = await acceptedSession();
    const cookieValue = await createSessionCookieValue(sessionId);

    const res = await GET(
      requestFor("/learn/lessons/0001-reviewing-an-overnight-agents-work.html", `session=${cookieValue}`),
      contextFor(["lessons", "0001-reviewing-an-overnight-agents-work.html"]),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves assets/course.css with the right content-type", async () => {
    const { sessionId } = await acceptedSession();
    const cookieValue = await createSessionCookieValue(sessionId);

    const res = await GET(
      requestFor("/learn/assets/course.css", `session=${cookieValue}`),
      contextFor(["assets", "course.css"]),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves the top-level MISSION.md a lesson links to with '../'", async () => {
    const { sessionId } = await acceptedSession();
    const cookieValue = await createSessionCookieValue(sessionId);

    const res = await GET(requestFor("/learn/MISSION.md", `session=${cookieValue}`), contextFor(["MISSION.md"]));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("404s (not 500s) for a missing file, for a signed-in user", async () => {
    const { sessionId } = await acceptedSession();
    const cookieValue = await createSessionCookieValue(sessionId);

    const res = await GET(
      requestFor("/learn/lessons/0099-does-not-exist.html", `session=${cookieValue}`),
      contextFor(["lessons", "0099-does-not-exist.html"]),
    );

    expect(res.status).toBe(404);
  });

  it("redirects to / (not 500s) for a revoked session", async () => {
    const db = await getDb();
    const { sessionId } = await acceptedSession();
    const cookieValue = await createSessionCookieValue(sessionId);
    await revokeSession(db, sessionId);

    const res = await GET(
      requestFor("/learn/lessons/0001-reviewing-an-overnight-agents-work.html", `session=${cookieValue}`),
      contextFor(["lessons", "0001-reviewing-an-overnight-agents-work.html"]),
    );

    expect(res.headers.get("location")).toBe(`${BASE}/`);
  });

  it("redirects to / with no session cookie at all", async () => {
    const res = await GET(
      requestFor("/learn/lessons/0001-reviewing-an-overnight-agents-work.html"),
      contextFor(["lessons", "0001-reviewing-an-overnight-agents-work.html"]),
    );

    expect(res.headers.get("location")).toBe(`${BASE}/`);
  });
});
