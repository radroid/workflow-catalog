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

  // See lib/error-messages.ts: only a fixed CODE ever goes in the URL. `n`
  // is a per-attempt remount nonce, not a security token — see the matching
  // comment on adminError in lib/actions/owner.ts for why it's needed: two
  // consecutive identical refusals must still redirect to two different
  // URLs, or <ErrorAlert>'s focus-on-mount effect never re-fires the
  // second time.
  function refused(code: InviteErrorCode): never {
    redirect(`/invite/${encodeURIComponent(token)}?error=${code}&n=${crypto.randomUUID()}`);
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
