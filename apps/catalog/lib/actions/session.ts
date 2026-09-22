"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db";
import { revokeSession } from "../sessions";
import { SESSION_COOKIE, verifySessionCookie } from "../session-cookie";

/** Revokes the session in the database (so the DB-backed check refuses it from now on, even if the signed cookie leaks) and clears the cookie. */
export async function signOutAction(): Promise<void> {
  const store = await cookies();
  const parsed = await verifySessionCookie(store.get(SESSION_COOKIE)?.value);

  if (parsed) {
    const db = await getDb();
    await revokeSession(db, parsed.sessionId);
  }

  store.delete(SESSION_COOKIE);
  redirect("/");
}
