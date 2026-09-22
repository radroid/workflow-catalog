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
