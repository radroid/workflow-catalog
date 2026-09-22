import type { Db } from "./db/types";
import { toIsoString, toIsoStringOrNull } from "./db/format";
import { randomToken, sha256Hex } from "./crypto";
import { validateDisplayName } from "./display-name";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "./session-cookie";

export const MAX_INVITES = 5;

export interface InviteSummary {
  id: string;
  createdAt: string;
  usedAt: string | null;
}

export type CreateInviteErrorCode = "invite_limit";
export type AcceptInviteErrorCode = "invalid_display_name" | "invalid_token";

export type CreateInviteResult =
  | { ok: true; id: string; token: string }
  | { ok: false; code: CreateInviteErrorCode; reason: string };

export type AcceptInviteResult =
  | { ok: true; sessionId: string; displayName: string }
  | { ok: false; code: AcceptInviteErrorCode; reason: string };

/** Postgres SQLSTATE for unique_violation / check_violation — see createInvite. */
function isConstraintViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505" || code === "23514";
}

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

// Exported so lib/error-messages.ts's fixed CODE -> message map (what the
// UI actually renders) reuses this exact text instead of maintaining a
// second copy that could drift from it.
export const INVITE_LIMIT_REASON = `All ${MAX_INVITES} invites already exist.`;

/**
 * Creates a single-use invite token, claiming the lowest free slot
 * (1..MAX_INVITES) in the same INSERT (spec F1: "five invites, sixth
 * refused"). A previous version of this comment claimed a
 * `WHERE (SELECT count(*) ...) < 5` guard was enough because "this is a
 * single-owner admin action, not a high-concurrency path" — that was wrong.
 * Neon's default isolation is READ COMMITTED, and each HTTP query is its
 * own transaction, so two concurrent `createInvite` calls can both read
 * count=4 and both insert, breaking the cap. PGlite's single connection
 * hid this in every test.
 *
 * The `slot SMALLINT UNIQUE CHECK (slot BETWEEN 1 AND 5)` column (see
 * db/migrations/0001_init.sql) makes the cap structural instead of a race:
 * the SELECT below picks the lowest slot not already taken, or falls back
 * to 0 if all five are — 0 always fails the CHECK constraint, and a slot
 * raced by a concurrent insert always fails the UNIQUE constraint. Either
 * way the INSERT itself fails, we catch that below, and treat it exactly
 * like "cap reached" — no retry, the admin just clicks Create invite again.
 */
export async function createInvite(db: Db): Promise<CreateInviteResult> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const id = randomUuid();

  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO invites (id, token_hash, slot)
       SELECT $1, $2, COALESCE(
         (SELECT MIN(s) FROM generate_series(1, $3) AS s WHERE s NOT IN (SELECT slot FROM invites)),
         0
       )
       RETURNING id`,
      [id, tokenHash, MAX_INVITES],
    );
    const row = rows[0];
    if (!row) {
      // Defensive only — the COALESCE fallback means this statement always
      // either returns a row or throws a constraint violation (caught
      // below), never silently returns zero rows.
      return { ok: false, code: "invite_limit", reason: INVITE_LIMIT_REASON };
    }
    return { ok: true, id: row.id, token };
  } catch (err) {
    if (isConstraintViolation(err)) {
      return { ok: false, code: "invite_limit", reason: INVITE_LIMIT_REASON };
    }
    throw err;
  }
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

// Exported for the same reason as INVITE_LIMIT_REASON above.
export const INVALID_TOKEN_REASON = "This invite link is invalid or has already been used.";

/**
 * Atomically claims the invite and creates a session — one statement, via a
 * data-modifying CTE, not the UPDATE-then-INSERT of two separate
 * statements this used to be. Two statements meant a failed INSERT (e.g. a
 * transient DB error) would still leave the invite marked used, burning it
 * for nothing; a single statement either does both or neither. Under
 * concurrent calls with the same token, exactly one UPDATE affects a row
 * (Postgres row-level locking serializes the two statements), every other
 * caller's `claimed` CTE is empty, so its INSERT ... SELECT ... FROM
 * claimed inserts nothing and the whole statement returns zero rows. A used
 * or unknown token is refused with the same message either way, so the
 * response can't be used to distinguish "used" from "never existed".
 */
export async function acceptInvite(db: Db, token: string, rawDisplayName: string): Promise<AcceptInviteResult> {
  const validation = validateDisplayName(rawDisplayName);
  if (!validation.ok) {
    return { ok: false, code: "invalid_display_name", reason: validation.reason };
  }

  const tokenHash = await sha256Hex(token);
  const sessionId = randomUuid();
  const expiresAt = new Date(Date.now() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toISOString();

  const { rows } = await db.query<{ id: string }>(
    `WITH claimed AS (
       UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING id
     )
     INSERT INTO sessions (id, invite_id, display_name, expires_at)
     SELECT $2, id, $3, $4 FROM claimed
     RETURNING id`,
    [tokenHash, sessionId, validation.value, expiresAt],
  );

  if (rows.length === 0) {
    return { ok: false, code: "invalid_token", reason: INVALID_TOKEN_REASON };
  }

  return { ok: true, sessionId, displayName: validation.value };
}
