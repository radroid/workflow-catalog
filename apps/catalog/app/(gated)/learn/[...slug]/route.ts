import { readFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { getActiveSessionFromCookieValue } from "../../../../lib/auth/require-session";
import { resolveLearnAsset } from "../../../../lib/learn";
import { SESSION_COOKIE } from "../../../../lib/session-cookie";

// Route Handlers don't participate in layouts (see the App Router route
// handler docs), so this does NOT inherit the gate from
// app/(gated)/layout.tsx — it is its own, independent instance of the
// database-backed session check, reading the cookie off `request` itself
// (see getActiveSessionFromCookieValue's comment for why). `params` is
// typed by hand rather than via the generated `RouteContext<...>` helper:
// that type only exists after a `next dev`/`next build` has run once, and
// `pnpm typecheck` on a clean clone runs before the first build.
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string[] }> }) {
  const session = await getActiveSessionFromCookieValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const { slug } = await context.params;
  const resolved = resolveLearnAsset(slug);
  if (!resolved) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = await readFile(resolved.absolutePath);
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": resolved.contentType },
  });
}
