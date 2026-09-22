"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerSecret, getSessionSecret } from "../auth-config";
import { timingSafeEqualString } from "../crypto";
import { createOwnerCookieValue, OWNER_COOKIE, ownerCookieOptions, verifyOwnerCookieValue } from "../owner-cookie";
import { ADMIN_FLASH_INVITE_COOKIE, adminFlashCookieOptions, clearAdminFlashCookie } from "../admin-flash";
import { getDb } from "../db";
import { createInvite } from "../invites";
import type { AdminErrorCode } from "../error-messages";

// See lib/error-messages.ts: only a fixed CODE ever goes in the URL, never
// free text, so a hand-crafted ?error= link can't put arbitrary words in
// the "Refused" box.
//
// `n` is a per-attempt nonce, not a security token — it exists only so two
// consecutive identical refusals (e.g. the wrong secret twice in a row)
// redirect to two different URLs. P09-B revision round: without it, a
// second identical refusal redirected to the exact same `?error=CODE` URL,
// so app/admin/page.tsx's <ErrorAlert> re-rendered in place instead of
// remounting — its focus-on-mount effect (empty deps) never re-ran, and the
// unchanged text was never re-announced to assistive tech either. The page
// renders <ErrorAlert key={n} ...>, so a new nonce forces a fresh mount
// every time, independent of whether the message text happens to repeat.
function adminError(code: AdminErrorCode): never {
  redirect(`/admin?error=${code}&n=${crypto.randomUUID()}`);
}

/** Server Functions are reachable by direct POST, not just through the rendered form — every action re-checks auth itself. */
async function requireOwner(): Promise<void> {
  const store = await cookies();
  const isOwner = await verifyOwnerCookieValue(store.get(OWNER_COOKIE)?.value);
  if (!isOwner) {
    adminError("not_owner");
  }
}

export async function ownerSignInAction(formData: FormData): Promise<void> {
  let ownerSecret: string;
  try {
    ownerSecret = getOwnerSecret();
    getSessionSecret(); // also required (createOwnerCookieValue signs with it) — validated up front for one clear error.
  } catch {
    adminError("not_configured");
  }

  const candidate = String(formData.get("secret") ?? "");
  if (!timingSafeEqualString(candidate, ownerSecret)) {
    adminError("wrong_secret");
  }

  const cookieValue = await createOwnerCookieValue();
  const store = await cookies();
  store.set(OWNER_COOKIE, cookieValue, ownerCookieOptions());
  redirect("/admin");
}

export async function ownerSignOutAction(): Promise<void> {
  const store = await cookies();
  store.delete(OWNER_COOKIE);
  redirect("/admin");
}

export async function createInviteAction(): Promise<void> {
  await requireOwner();

  const db = await getDb();
  const result = await createInvite(db);
  const store = await cookies();

  if (!result.ok) {
    adminError(result.code);
  }

  store.set(ADMIN_FLASH_INVITE_COOKIE, result.token, adminFlashCookieOptions());
  redirect("/admin");
}

export async function dismissInviteFlashAction(): Promise<void> {
  await requireOwner();
  const store = await cookies();
  clearAdminFlashCookie(store);
  redirect("/admin");
}
