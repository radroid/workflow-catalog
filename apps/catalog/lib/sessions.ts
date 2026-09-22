import type { Db } from "./db/types";

export interface ActiveSession {
  id: string;
  displayName: string;
}

/**
 * The database-backed layer of the two-layer session check (the other is
 * `verifySessionCookie`'s signature-only check in session-cookie.ts). Only
 * a session that exists AND has not been revoked counts as active — this is
 * what makes sign-out (and any future admin revocation) actually take
 * effect even though the signed cookie itself would otherwise still verify.
 */
export async function findActiveSession(db: Db, sessionId: string): Promise<ActiveSession | null> {
  const { rows } = await db.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM sessions WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, displayName: row.display_name };
}

/** Sign-out: revoke the session so the database-backed check refuses it from now on. */
export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}
