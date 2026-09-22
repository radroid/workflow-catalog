"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionSecret } from "../auth-config";
import { getDb } from "../db";
import { acceptInvite } from "../invites";
import { createSessionCookieValue, SESSION_COOKIE, sessionCookieOptions } from "../session-cookie";

export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");

  function refused(message: string): never {
    redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(message)}`);
  }

  try {
    getSessionSecret();
  } catch {
    refused("Server is not configured (SESSION_SECRET missing). Refusing to sign in.");
  }

  if (!token) {
    refused("This invite link is invalid or has already been used.");
  }

  const displayName = String(formData.get("displayName") ?? "");
  const db = await getDb();
  const result = await acceptInvite(db, token, displayName);
  if (!result.ok) {
    refused(result.reason);
  }

  const cookieValue = await createSessionCookieValue(result.sessionId);
  const store = await cookies();
  store.set(SESSION_COOKIE, cookieValue, sessionCookieOptions());
  redirect("/install");
}
