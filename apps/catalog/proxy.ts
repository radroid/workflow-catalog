import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionCookie } from "./lib/session-cookie";

// Access control, layer 1 of 2 (spec: "public routes are /, /invite/[token],
// /admin (behind its own owner gate), and static assets. Everything else
// needs a session."). This is the *optimistic* check: cookie-signature
// only, no database call, so it stays fast and dependency-light (no DB
// driver import here — see lib/session-cookie.ts's header comment). Layer 2
// is the database-backed revocation check in every gated layout/route — see
// lib/auth/require-session.ts and app/(gated)/learn/[...slug]/route.ts.

function isPublicPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/admin") return true;
  if (pathname.startsWith("/invite/")) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  const parsed = await verifySessionCookie(raw);
  if (!parsed) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next.js internals and the handful of conventional
  // public files that must load on every page, signed in or not.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)"],
};
