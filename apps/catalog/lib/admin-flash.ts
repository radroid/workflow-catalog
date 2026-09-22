// A one-time-display flash cookie for the freshly created invite link (spec:
// "show the raw link once"). Not signed: it's write-only-by-server,
// read-only-for-display, never used to authorize anything, so tampering
// with it can at worst show the owner a wrong-looking string — not a
// security boundary the way the owner/session cookies are.

export const ADMIN_FLASH_INVITE_COOKIE = "admin_flash_invite";
export const ADMIN_FLASH_MAX_AGE_SECONDS = 120;

export interface AdminFlashCookieOptions {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/admin";
  maxAge: number;
}

export function adminFlashCookieOptions(): AdminFlashCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: ADMIN_FLASH_MAX_AGE_SECONDS,
  };
}

export interface DeletableCookieStore {
  delete(options: { name: string; path: string }): unknown;
}

/**
 * Next's `cookies().delete(name)` (the bare-string overload) emits a
 * deletion `Set-Cookie` with `Path=/`, regardless of the path the cookie was
 * originally set with. A browser only overwrites/removes a cookie when the
 * deletion's path matches the original exactly — since this cookie is set
 * with `path: "/admin"` (above), a bare `delete(ADMIN_FLASH_INVITE_COOKIE)`
 * silently fails to clear it; the "shown once" invite link kept reappearing
 * after Dismiss. The object form lets us pass the same path back.
 */
export function clearAdminFlashCookie(store: DeletableCookieStore): void {
  store.delete({ name: ADMIN_FLASH_INVITE_COOKIE, path: "/admin" });
}
