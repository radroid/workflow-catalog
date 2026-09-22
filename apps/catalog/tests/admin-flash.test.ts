import { describe, expect, it } from "vitest";
import { ADMIN_FLASH_INVITE_COOKIE, clearAdminFlashCookie, type DeletableCookieStore } from "../lib/admin-flash";

describe("admin flash cookie", () => {
  it("deletes with the same path it was set with, not the default '/'", () => {
    // Next's cookies().delete(name) (the bare-string overload) emits a
    // deletion Set-Cookie with Path=/, regardless of the path the cookie
    // was originally set with (path: "/admin" — see
    // adminFlashCookieOptions). A browser only overwrites/removes a cookie
    // when the deletion's path matches the original exactly, so that bare
    // form silently fails to clear this cookie and Dismiss did nothing.
    // Injecting a fake store (rather than a real cookies() instance, which
    // needs Next's request context) proves clearAdminFlashCookie asks for
    // the matching path, independent of Next's own delete() implementation.
    const deleteCalls: unknown[] = [];
    const fakeStore: DeletableCookieStore = {
      delete: (options) => deleteCalls.push(options),
    };

    clearAdminFlashCookie(fakeStore);

    expect(deleteCalls).toEqual([{ name: ADMIN_FLASH_INVITE_COOKIE, path: "/admin" }]);
  });
});
