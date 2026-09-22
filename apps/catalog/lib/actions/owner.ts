"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerSecret, getSessionSecret } from "../auth-config";
import { timingSafeEqualString } from "../crypto";
import { createOwnerCookieValue, OWNER_COOKIE, ownerCookieOptions, verifyOwnerCookieValue } from "../owner-cookie";
import { ADMIN_FLASH_INVITE_COOKIE, adminFlashCookieOptions } from "../admin-flash";
import { getDb } from "../db";
import { createInvite } from "../invites";

function adminError(message: string): never {
  redirect(`/admin?error=${encodeURIComponent(message)}`);
}

/** Server Functions are reachable by direct POST, not just through the rendered form — every action re-checks auth itself. */
async function requireOwner(): Promise<void> {
  const store = await cookies();
  const isOwner = await verifyOwnerCookieValue(store.get(OWNER_COOKIE)?.value);
  if (!isOwner) {
    adminError("Sign in as the owner first.");
  }
}

export async function ownerSignInAction(formData: FormData): Promise<void> {
  let ownerSecret: string;
  try {
    ownerSecret = getOwnerSecret();
    getSessionSecret(); // also required (createOwnerCookieValue signs with it) — validated up front for one clear error.
  } catch {
    adminError("Server is not configured (OWNER_SECRET/SESSION_SECRET missing). Refusing to sign in.");
  }

  const candidate = String(formData.get("secret") ?? "");
  if (!timingSafeEqualString(candidate, ownerSecret)) {
    adminError("Incorrect secret.");
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
    adminError(result.reason);
  }

  store.set(ADMIN_FLASH_INVITE_COOKIE, result.token, adminFlashCookieOptions());
  redirect("/admin");
}

export async function dismissInviteFlashAction(): Promise<void> {
  await requireOwner();
  const store = await cookies();
  store.delete(ADMIN_FLASH_INVITE_COOKIE);
  redirect("/admin");
}
