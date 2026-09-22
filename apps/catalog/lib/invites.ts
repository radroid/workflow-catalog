import type { Db } from "./db/types";
import { toIsoString, toIsoStringOrNull } from "./db/format";
import { randomToken, sha256Hex } from "./crypto";
import { validateDisplayName } from "./display-name";

export const MAX_INVITES = 5;

export interface InviteSummary {
  id: string;
  createdAt: string;
  usedAt: string | null;
}

export type CreateInviteResult = { ok: true; id: string; token: string } | { ok: false; reason: string };

export type AcceptInviteResult = { ok: true; sessionId: string; displayName: string } | { ok: false; reason: string };

function randomUuid(): string {
  return crypto.randomUUID();
}

export async function listInvites(db: Db): Promise<InviteSummary[]> {
  const { rows } = await db.query<{ id: string; created_at: unknown; used_at: unknown }>(
    "SELECT id, created_at, used_at FROM invites ORDER BY created_at ASC",
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: toIsoString(row.created_at),
    usedAt: toIsoStringOrNull(row.used_at),
  }));
}

/**
 * Creates a single-use invite token. Refuses once 5 invites already exist
 * (spec F1: "five invites, sixth refused"). The `WHERE ... < $1` guard makes
 * the check part of the same INSERT statement rather than a separate
 * read-then-write race; this is a single-owner admin action, not a
 * high-concurrency path, so statement-level atomicity is enough (the invite
 * *acceptance* path is the one the spec requires to be race-proof under
 * real concurrency — see acceptInvite below).
 */
export async function createInvite(db: Db): Promise<CreateInviteResult> {
  const existing = await listInvites(db);
  if (existing.length >= MAX_INVITES) {
    return { ok: false, reason: `All ${MAX_INVITES} invites already exist. Revoke one before creating another.` };
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const id = randomUuid();

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO invites (id, token_hash)
     SELECT $1, $2
     WHERE (SELECT count(*) FROM invites) < $3
     RETURNING id`,
    [id, tokenHash, MAX_INVITES],
  );

  if (rows.length === 0) {
    return { ok: false, reason: `All ${MAX_INVITES} invites already exist. Revoke one before creating another.` };
  }

  return { ok: true, id, token };
}

export type InviteTokenStatus = "valid" | "invalid";

/** Read-only check for the GET render of /invite/[token] — no mutation. */
export async function checkInviteToken(db: Db, token: string): Promise<InviteTokenStatus> {
  const tokenHash = await sha256Hex(token);
  const { rows } = await db.query<{ used_at: unknown }>("SELECT used_at FROM invites WHERE token_hash = $1", [
    tokenHash,
  ]);
  const invite = rows[0];
  if (!invite || toIsoStringOrNull(invite.used_at) !== null) return "invalid";
  return "valid";
}

/**
 * Atomically claims the invite and creates a session. The `UPDATE ... WHERE
 * used_at IS NULL RETURNING` is the whole mechanism: under concurrent calls
 * with the same token, exactly one UPDATE affects a row (Postgres row-level
 * locking serializes the two statements), every other caller sees zero rows
 * and is refused. A used or unknown token is refused with the same message
 * either way, so the response can't be used to distinguish "used" from
 * "never existed".
 */
export async function acceptInvite(db: Db, token: string, rawDisplayName: string): Promise<AcceptInviteResult> {
  const validation = validateDisplayName(rawDisplayName);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const tokenHash = await sha256Hex(token);
  const { rows } = await db.query<{ id: string }>(
    "UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING id",
    [tokenHash],
  );
  const invite = rows[0];
  if (!invite) {
    return { ok: false, reason: "This invite link is invalid or has already been used." };
  }

  const sessionId = randomUuid();
  await db.query("INSERT INTO sessions (id, invite_id, display_name) VALUES ($1, $2, $3)", [
    sessionId,
    invite.id,
    validation.value,
  ]);

  return { ok: true, sessionId, displayName: validation.value };
}
