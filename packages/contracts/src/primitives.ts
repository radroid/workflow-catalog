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
 *
 * The `.regex(...)` is deliberately redundant with `z.url({ protocol })`:
 * the `protocol` option is a zod-only runtime refinement invisible to
 * `z.toJSONSchema` (it never lowers to a JSON Schema keyword), so on its
 * own the *emitted* `.schema.json` would describe any absolute URL —
 * `javascript:`, `file:`, `chrome-extension:` included — as valid. The
 * trailing `.regex()` is a zod "check" that *does* lower to JSON Schema's
 * `"pattern"`, so an ajv-based consumer (the bridge server) enforces the
 * same http(s)-only restriction the zod runtime does. See
 * `job-assistant/test/url-schema-parity.test.ts`.
 */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).regex(/^https?:\/\//);

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

/**
 * browser-boundary.md's acceptance gates require rejecting "unknown or
 * partial results" and an oversized group; picked to comfortably cover a
 * single day's applications while staying well short of a runaway group.
 * Shared by `OpenApplicationGroupPayload.items` (`bridge-envelopes.ts`) and
 * `SessionManifest.items` (`session.ts`) — a session manifest is the
 * runner-side record an `OpenApplicationGroup` command is derived from
 * (mvp-spec §5), so the two must never disagree on the ceiling.
 */
export const MAX_APPLICATION_GROUP_SIZE = 20;

/**
 * A non-empty string bounded by UTF-8 *byte* length, not JS string
 * `.length` (UTF-16 code units, which is what `z.string().max(n)` counts).
 * For multi-byte text (CJK, emoji, accented Latin, ...) `.length` undercounts
 * real wire size by up to 3x — one UTF-16 code unit can be up to 3 UTF-8
 * bytes, and a surrogate pair is 2 units but only 4 bytes (2x). A cap sized
 * purely off `.max()` (e.g. a "200,000 character" limit) can admit a
 * payload of 600 KB-1.2 MB of actual UTF-8 bytes despite passing the
 * schema — comfortably over the bridge's 256 KB HTTP body cap (mvp-spec
 * §5). This check counts real bytes instead.
 *
 * No JSON Schema keyword counts UTF-8 bytes (`maxLength` counts Unicode
 * codepoints), so — like the extra `.regex()` on `httpUrlSchema` is
 * JSON-Schema-*visible* — this bound is necessarily JSON-Schema-*invisible*:
 * a `.refine()`, enforced by the zod runtime (the bridge server and any
 * other real parser) but not expressible as an ajv-checkable keyword in the
 * emitted `.schema.json`. The bridge's own HTTP body-size cap is the actual
 * wire-level backstop; this is a fail-fast, precisely-worded error for
 * in-process producers (the runner) before a payload ever reaches the wire.
 */
export function utf8BoundedTextSchema(maxBytes: number) {
  return nonEmptyStringSchema.refine(
    (value: string) => new TextEncoder().encode(value).length <= maxBytes,
    `must be at most ${maxBytes} bytes when UTF-8 encoded`,
  );
}
