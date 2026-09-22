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
 * `httpUrlSchema` with a length cap on the raw input. The cap has to run
 * before the URL check. zod's URL check hands later checks a rewritten value:
 * it trims surrounding whitespace and deletes every tab, CR and LF (zod 4.5.4,
 * `$ZodURL`). So `httpUrlSchema.max(n)` would measure the rewritten string and
 * accept a URL padded with any amount of whitespace. Here `z.string().max(n)`
 * sees the raw input first, then the same two checks as `httpUrlSchema` run in
 * the same order. The emitted JSON Schema is `httpUrlSchema`'s plus
 * `maxLength`. zod's `.max()` counts UTF-16 code units and JSON Schema's
 * `maxLength` counts code points, so the JSON Schema bound is never the
 * stricter one.
 */
export function boundedHttpUrlSchema(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .check(z.url({ protocol: /^https?$/ }))
    .regex(/^https?:\/\//);
}

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
 * mvp-spec §5: every bridge request has a "body size cap 256 KB", taken here
 * as 256 KiB. The bridge rejects a larger body before parsing it. The
 * `POST /events` bodies are capped so that every body zod accepts also
 * serializes within this (see the caps in bridge-envelopes.ts and
 * `bridge-body-size.test.ts`).
 */
export const MAX_BRIDGE_BODY_BYTES = 262_144;

/**
 * A non-empty string capped by its size as JSON: the UTF-8 byte length of
 * `JSON.stringify(value)`, the two quote marks included. That is exactly what
 * the field adds to a serialized envelope, so caps measured this way add up to
 * a real bound on the envelope.
 *
 * Neither simpler measure is enough. `z.string().max(n)` counts UTF-16 code
 * units, and one code unit can take up to 3 bytes of UTF-8. Raw UTF-8 bytes
 * miss JSON escaping: a newline, quote or backslash is 1 byte of text but 2
 * bytes of JSON, and a control character such as U+0001 is 1 byte of text but
 * 6 bytes of JSON (`\u0001`). Under a raw 200,000-byte cap, text can serialize
 * to 1.2 MB.
 *
 * JSON Schema has no keyword for this bound. The emitted schema gets
 * `maxLength: maxBytes - 2` instead. It is looser, so it never rejects a valid
 * string: every code point serializes to at least 1 byte. The `.max()` that
 * emits it is redundant at runtime, because the byte check implies it. The
 * `description` says where the byte bound is enforced.
 */
export function utf8BoundedTextSchema(maxBytes: number) {
  return nonEmptyStringSchema
    .max(maxBytes - 2)
    .refine(
      (value: string) => new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes,
      `must be at most ${maxBytes} bytes as UTF-8 JSON (JSON.stringify, quotes included)`,
    )
    .describe(
      `At most ${maxBytes} bytes as UTF-8 JSON: new TextEncoder().encode(JSON.stringify(text)).length, ` +
        "the two quote marks included. JSON Schema cannot express that bound, so maxLength is only a looser " +
        "code-point limit (every code point serializes to at least 1 byte). The byte bound is enforced exactly " +
        "by the zod schema in @workflow-catalog/contracts, and on the wire by the bridge's raw 256 KB " +
        `(${MAX_BRIDGE_BODY_BYTES}-byte) request body cap.`,
    );
}
