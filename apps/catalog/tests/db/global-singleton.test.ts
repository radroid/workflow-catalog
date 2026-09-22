import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BASE = "http://localhost:3104";

function requestFor(pathname: string, cookieHeader?: string): NextRequest {
  return new NextRequest(new URL(pathname, BASE), cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
}

function contextFor(slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

// Regression coverage for the P09-A round-2 UI critique: under `next dev`
// (Turbopack), a Route Handler and a Server Component can each end up as
// separate bundled copies of lib/db/index.ts. A module-level `let cached`
// would then be two independent bindings, each lazily opening its own
// PGlite client against the same on-disk directory — which is how a
// signed-out cookie kept opening lessons, and a brand-new session got
// bounced, in a live walkthrough. The fix moved the cache onto
// `globalThis`. `vi.resetModules()` + a fresh dynamic `import()` is the
// closest a plain Vitest run gets to "two separate bundled copies of the
// same module": it clears Vitest's module registry, so the next `import()`
// of the same specifier re-evaluates the module's top-level code from
// scratch (a fresh `let` binding, pre-fix) — while `globalThis` itself is
// the real Node global object and is untouched by resetModules, which is
// exactly why caching there is the fix.
describe("lib/db getDb() singleton survives duplicate module instances", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "wc-catalog-db-singleton-"));
    vi.stubEnv("CATALOG_PGLITE_DIR", dataDir);
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
  });

  afterEach(async () => {
    const { resetDbCacheForTests } = await import("../../lib/db");
    resetDbCacheForTests();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("two independently-loaded copies of the module resolve getDb() to the exact same Db instance", async () => {
    const moduleA = await import("../../lib/db");
    const dbA = await moduleA.getDb();

    vi.resetModules();
    const moduleB = await import("../../lib/db");
    const dbB = await moduleB.getDb();

    // Sanity check that resetModules actually gave us a fresh module
    // instance — otherwise this test would trivially pass for the wrong
    // reason (never having exercised the duplicate-module scenario at all).
    expect(moduleB).not.toBe(moduleA);
    // The real assertion: even so, both copies share one underlying Db.
    expect(dbB).toBe(dbA);
  });

  it("a session revoked before a module-registry reset is still refused by the learn route after it", async () => {
    // "Generation 1": create an invite, accept it, and revoke the session —
    // all through this generation's copy of lib/db.
    const dbModuleGen1 = await import("../../lib/db");
    const { createInvite, acceptInvite } = await import("../../lib/invites");
    const { revokeSession } = await import("../../lib/sessions");
    const { createSessionCookieValue } = await import("../../lib/session-cookie");

    const dbGen1 = await dbModuleGen1.getDb();
    const created = await createInvite(dbGen1);
    if (!created.ok) throw new Error("test setup: createInvite failed");
    const accepted = await acceptInvite(dbGen1, created.token, "Ada Quill");
    if (!accepted.ok) throw new Error("test setup: acceptInvite failed");
    const cookieValue = await createSessionCookieValue(accepted.sessionId);
    await revokeSession(dbGen1, accepted.sessionId);

    // "Generation 2": a completely fresh module registry, simulating the
    // learn route handler living in a different Turbopack bundle from
    // whatever revoked the session above — its *own* transitive import of
    // lib/db/index.ts (via lib/auth/require-session.ts) must still see the
    // revocation for this test to prove the fix, not just the route's
    // already-covered 404/redirect logic (see tests/learn-route.test.ts).
    vi.resetModules();
    const { GET } = await import("../../app/(gated)/learn/[...slug]/route");

    const res = await GET(
      requestFor("/learn/lessons/0001-reviewing-an-overnight-agents-work.html", `session=${cookieValue}`),
      contextFor(["lessons", "0001-reviewing-an-overnight-agents-work.html"]),
    );

    expect(res.headers.get("location")).toBe(`${BASE}/`);
  });
});
