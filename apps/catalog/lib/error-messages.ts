// Fixed, server-authored copy for every refusal message shown on /admin and
// /invite. Both pages used to render `?error=<free text>` straight from the
// URL: since a query param is attacker-controlled, anyone could craft a
// link like /invite/<token>?error=Your%20account%20is%20locked and have the
// site display that fake text in its own "Refused" box. Mapping a small,
// fixed set of CODES to fixed messages closes that off structurally — an
// unrecognized code (including arbitrary attacker text) always falls back
// to GENERIC_ERROR_MESSAGE, never reflects what was actually in the URL.

import { INVALID_TOKEN_REASON, INVITE_LIMIT_REASON } from "./invites";

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

export type AdminErrorCode = "not_owner" | "not_configured" | "wrong_secret" | "invite_limit";

export const ADMIN_ERROR_MESSAGES: Record<AdminErrorCode, string> = {
  not_owner: "Sign in as the owner first.",
  not_configured: "Server is not configured (OWNER_SECRET/SESSION_SECRET missing). Refusing to sign in.",
  wrong_secret: "Incorrect secret.",
  invite_limit: INVITE_LIMIT_REASON,
};

export function adminErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  // Object.hasOwn, not a bracket lookup + `?? GENERIC_ERROR_MESSAGE`: every
  // plain object inherits properties like `constructor` and (in most JS
  // engines) an own-ish `__proto__` accessor from Object.prototype, so
  // `ADMIN_ERROR_MESSAGES["__proto__"]` resolves to `Object.prototype`
  // itself and `ADMIN_ERROR_MESSAGES["constructor"]` resolves to the
  // `Object` constructor function — both truthy, so `??` never falls back,
  // and React then throws trying to render a function/object as a child. A
  // `?error=__proto__` link crashed the page this way. hasOwn only matches
  // a key this object was actually built with, i.e. one of AdminErrorCode.
  return Object.hasOwn(ADMIN_ERROR_MESSAGES, code)
    ? ADMIN_ERROR_MESSAGES[code as AdminErrorCode]
    : GENERIC_ERROR_MESSAGE;
}

export type InviteErrorCode = "not_configured" | "missing_token" | "invalid_token" | "invalid_display_name";

export const INVITE_ERROR_MESSAGES: Record<InviteErrorCode, string> = {
  not_configured: "Server is not configured (SESSION_SECRET missing). Refusing to sign in.",
  missing_token: INVALID_TOKEN_REASON,
  invalid_token: INVALID_TOKEN_REASON,
  invalid_display_name: "Display name must be 1–40 characters, with no control or invisible formatting characters.",
};

export function inviteErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  // See adminErrorMessage's comment: Object.hasOwn (not a bracket lookup +
  // `?? GENERIC_ERROR_MESSAGE`) so an inherited property name like
  // `__proto__` or `constructor` can never resolve to anything but the
  // generic fallback.
  return Object.hasOwn(INVITE_ERROR_MESSAGES, code)
    ? INVITE_ERROR_MESSAGES[code as InviteErrorCode]
    : GENERIC_ERROR_MESSAGE;
}
