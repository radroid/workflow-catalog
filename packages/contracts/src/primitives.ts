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
 * `z.url()`'s own `protocol` option, shared by every URL primitive below so
 * `httpUrlSchema` and `boundedHttpUrlSchema` can never drift onto two
 * different definitions of "http(s)".
 */
const HTTP_PROTOCOL = /^https?$/;

/**
 * Rejects a string with leading or trailing whitespace — must run *before*
 * `z.url()` in the check chain (see `httpUrlSchema` below for why). Any
 * ASCII or Unicode character `\s` matches, not just the space character;
 * `[\s\S]` (rather than `.`) so a newline in the middle of the string
 * doesn't stop the match, since `.` excludes line terminators without the
 * `s`/dotAll flag.
 */
const NO_SURROUNDING_WHITESPACE = /^(?!\s)[\s\S]*(?<!\s)$/;

/**
 * `z.url()`'s `protocol` option, restated as a `.regex()` so it lowers to
 * JSON Schema (see the class doc comment on `httpUrlSchema`).
 */
const HTTP_PREFIX = /^https?:\/\//;

/**
 * Requires a non-empty run of non-whitespace characters between `://` and
 * the next `/`, `?`, `#`, or the end of the string — i.e. a host with no
 * embedded space and no empty-host `https://`. `z.url()`'s own
 * `new URL(...)` call already rejects both at the zod level (confirmed:
 * `new URL("https://")` and `new URL("https://exa mple.com/")` both throw),
 * but that rejection is a runtime-only `new URL()` call and, like the
 * `protocol` option above, never lowers to a JSON Schema keyword. Without
 * this regex the *emitted* schema would describe `https://` and
 * `https://exa mple.com/` as valid, so an ajv-based consumer would silently
 * accept what the zod runtime rejects — see
 * `job-assistant/test/url-schema-parity.test.ts`.
 *
 * This intentionally only bounds the *authority* component (the part
 * `new URL()` would call the host), matching the two cases named in the
 * P01.1 packet. It does not forbid whitespace elsewhere in the URL —
 * `z.url()` already deletes an embedded tab/CR/LF from the whole string
 * before parsing (WHATWG URL input preprocessing), which this regex, run
 * after `z.url()` below, sees the same as `z.url()` does.
 */
const NON_EMPTY_HTTP_AUTHORITY = /^https?:\/\/[^\s/?#]+(?:[/?#]|$)/;

/**
 * An absolute URL restricted to `http:`/`https:`. Per
 * `docs/spec/research/browser-boundary.md` ("Minimal protocol contract" and
 * the acceptance gates): "reject `javascript:`, local files, privileged
 * browser URLs, and arbitrary code" and mvp-spec §7.2 ("no action can be
 * triggered by content"). `javascript:`, `file:`, `chrome:`, `chrome-extension:`
 * and similar all fail the protocol check below.
 *
 * Four checks, in this order:
 * 1. `NO_SURROUNDING_WHITESPACE`, first, on the raw input. zod 4.5.4's
 *    `$ZodURL` check (triggered by `z.url()` below) trims surrounding
 *    whitespace and hands *later* checks the trimmed value (confirmed by
 *    reading zod's source: `payload.value = ... stripTabAndNewline(trimmed)`
 *    always overwrites the value zod checks see next, even without
 *    `normalize`). A `.regex()` chained after `z.url()` would therefore see
 *    an already-trimmed string and silently accept `"  https://x"` — which
 *    is exactly issue round-3 of the P01 review found. Running this check
 *    first, before anything trims the input, makes zod reject the
 *    whitespace outright instead.
 * 2. `z.url({ protocol })`: well-formed URL, http(s) only. The `protocol`
 *    option is a zod-only runtime refinement invisible to `z.toJSONSchema`
 *    (it never lowers to a JSON Schema keyword) — checks 3 and 4 restate
 *    what it and the underlying `new URL()` call already enforce, purely so
 *    the *emitted* JSON Schema enforces the same rules an ajv-based
 *    consumer (the bridge server) sees.
 * 3. `HTTP_PREFIX`: restates the protocol check as a `.regex()`, which does
 *    lower to JSON Schema's `"pattern"`.
 * 4. `NON_EMPTY_HTTP_AUTHORITY`: restates "well-formed URL" — non-empty,
 *    space-free host — the same way, for the same reason.
 *
 * See `job-assistant/test/url-schema-parity.test.ts` for the ajv-vs-zod
 * proof.
 */
export const httpUrlSchema = z
  .string()
  .regex(NO_SURROUNDING_WHITESPACE, "must not have leading or trailing whitespace")
  .check(z.url({ protocol: HTTP_PROTOCOL }))
  .regex(HTTP_PREFIX)
  .regex(NON_EMPTY_HTTP_AUTHORITY);

/**
 * `httpUrlSchema` with a length cap on the raw input. The cap has to run
 * before the URL check for the same reason `NO_SURROUNDING_WHITESPACE` does
 * (see `httpUrlSchema` above): zod's URL check hands later checks a
 * rewritten value, trimmed and with every tab, CR and LF deleted (zod
 * 4.5.4, `$ZodURL`). So `httpUrlSchema.max(n)` would measure the rewritten
 * string and accept a URL padded with any amount of whitespace. Here
 * `z.string().max(n)` sees the raw input first, then the same checks as
 * `httpUrlSchema` run in the same order. The emitted JSON Schema is
 * `httpUrlSchema`'s plus `maxLength`. zod's `.max()` counts UTF-16 code
 * units and JSON Schema's `maxLength` counts code points, so the JSON
 * Schema bound is never the stricter one.
 */
export function boundedHttpUrlSchema(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .regex(NO_SURROUNDING_WHITESPACE, "must not have leading or trailing whitespace")
    .check(z.url({ protocol: HTTP_PROTOCOL }))
    .regex(HTTP_PREFIX)
    .regex(NON_EMPTY_HTTP_AUTHORITY);
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

/** A lowercase- or uppercase-hex content digest (sha256, sha1, ...). The type does not pin an algorithm or a length; `JobSnapshot.contentHash` (job-snapshot.ts) documents the one digest producers compute. */
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
 * `POST /events` bodies are capped so that every JSON body zod accepts also
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
