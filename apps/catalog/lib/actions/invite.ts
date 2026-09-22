"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionSecret } from "../auth-config";
import { getDb } from "../db";
import { acceptInvite } from "../invites";
import { createSessionCookieValue, SESSION_COOKIE, sessionCookieOptions } from "../session-cookie";
import type { InviteErrorCode } from "../error-messages";

export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");

  // See lib/error-messages.ts: only a fixed CODE ever goes in the URL.
  function refused(code: InviteErrorCode): never {
    redirect(`/invite/${encodeURIComponent(token)}?error=${code}`);
  }

  try {
    getSessionSecret();
  } catch {
    refused("not_configured");
  }

  if (!token) {
    refused("missing_token");
  }

  const displayName = String(formData.get("displayName") ?? "");
  const db = await getDb();
  const result = await acceptInvite(db, token, displayName);
  if (!result.ok) {
    refused(result.code);
  }

  const cookieValue = await createSessionCookieValue(result.sessionId);
  const store = await cookies();
  store.set(SESSION_COOKIE, cookieValue, sessionCookieOptions());
  redirect("/install");
}
