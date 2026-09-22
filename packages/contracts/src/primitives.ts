import { z } from "zod";

/**
 * The bridge envelope protocol version. Every bridge envelope (session
 * manifest commands, `/events` bodies) carries this literal so a future
 * breaking change to the wire shape can be introduced as `protocol: 2`
 * without guessing from field shape alone.
 */
export const PROTOCOL_VERSION = 1 as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

/**
 * A durable identifier. `docs/spec/research/browser-boundary.md` ("Sleeping,
 * restart, and exactly-once limits"): "Use durable UUIDs for application,
 * session, device, and command records" — Chrome's own tab/group IDs are
 * only unique within a browser session, so every record this workflow
 * persists across a restart is a UUID instead. Accepts any RFC 9562/4122
 * UUID version (zod's default `z.uuid()` — not narrowed to v4 — so a fixture
 * or a future producer using v7 for sortability still validates).
 */
export const uuidSchema = z.uuid();

/**
 * An absolute URL restricted to `http:`/`https:`. Per
 * `docs/spec/research/browser-boundary.md` ("Minimal protocol contract" and
 * the acceptance gates): "reject `javascript:`, local files, privileged
 * browser URLs, and arbitrary code" and mvp-spec §7.2 ("no action can be
 * triggered by content"). `javascript:`, `file:`, `chrome:`, `chrome-extension:`
 * and similar all fail the protocol check below.
 */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * An ISO-8601 datetime string with an explicit timezone — either the `Z`
 * suffix `Date#toISOString()` produces, or a numeric offset. Never a
 * timezone-less "local" datetime, which would be ambiguous across the
 * runner's machine and the catalog.
 */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * An ISO-8601 calendar date (`YYYY-MM-DD`), used where only a day matters
 * (for example a changelog entry date) and a full timestamp would be false
 * precision.
 */
export const isoDateSchema = z.iso.date();

/** A semantic version string, e.g. `"0.1.0"`. Used for `workflow.json`'s own version (F12) and workspace.json's pinned `packageVersion`. */
export const semverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semantic version, e.g. 1.2.3",
  );

/** A lowercase- or uppercase-hex content digest (sha256, sha1, ...). Length is left open since the hashing algorithm is a runner implementation detail P01 does not pin. */
export const hexDigestSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8,}$/, "must be a hex digest string");

/** Trimmed, non-empty single-line-or-more text. The common case for required free text fields (claim text, notes headers, etc.) where an empty string would silently mean "nothing was extracted." */
export const nonEmptyStringSchema = z.string().min(1);
