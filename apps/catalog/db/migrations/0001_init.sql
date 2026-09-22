-- 0001_init.sql
--
-- Exactly three tables. No career data, ever — see
-- docs/spec/implementation/P09-catalog-site.md and the schema-allowlist
-- test in tests/db/schema.test.ts, which fails if a column is added here
-- without updating that allowlist deliberately.
--
-- IDs are generated in application code (Web Crypto `crypto.randomUUID()`
-- is not used here either — see lib/crypto.ts's `randomToken`/UUID helper),
-- not by a DEFAULT expression, so this schema has no dependency on the
-- pgcrypto extension (gen_random_uuid()) being present.
--
-- Applied automatically to PGlite on every local/dev/test start (see
-- lib/db/migrate.ts). Production (Neon) is migrated once by hand — see
-- apps/catalog/README.md.

-- `slot` makes the 5-invite cap structural rather than a read-then-write
-- race: under Neon's default READ COMMITTED isolation (each HTTP query is
-- its own transaction), two concurrent `count(*) < 5` reads could both see
-- 4 and both insert. A UNIQUE, bounded slot can't be double-claimed no
-- matter how the two INSERTs interleave — see lib/invites.ts's createInvite.
CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  slot SMALLINT NOT NULL UNIQUE CHECK (slot BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

-- `expires_at` is set in application code (30 days out, matching the
-- session cookie's own max-age — see lib/session-cookie.ts's
-- SESSION_COOKIE_MAX_AGE_SECONDS) and enforced in findActiveSession's query
-- alongside `revoked_at`, so a session can't outlive its cookie even if it's
-- never explicitly revoked.
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  invite_id UUID NOT NULL REFERENCES invites (id),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS install_status (
  session_id UUID NOT NULL REFERENCES sessions (id),
  item TEXT NOT NULL CHECK (item IN ('node', 'runner', 'provider', 'workspace', 'extension')),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, item)
);
