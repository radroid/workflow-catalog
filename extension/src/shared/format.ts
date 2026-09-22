/**
 * Display-only formatting (review fold-in i: "Show human-readable
 * timestamps. Abbreviate UUIDs with the full value in a title or
 * visually-hidden text."). Every value these read (JobCapture.occurredAt,
 * StoredDeviceToken.pairedAt, SessionManifest.createdAt/sessionId) keeps
 * its real, exact form in storage/exports; only what's rendered changes.
 */

/**
 * `iso` is expected to already be a valid ISO 8601 datetime (every caller
 * gets one from a contracts-validated envelope). Falls back to the raw
 * string, unchanged, if it somehow isn't parseable — never throws, and
 * never hides a value a person might need to debug from.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const UUID_PREFIX_LENGTH = 8;

/** Shortens a UUID to its first 8 hex characters for compact display. Not
 * a hash or a redaction — the exact full value belongs in a `title`
 * attribute or visually-hidden text at the call site, since this alone
 * isn't enough to identify the record if someone needs to look it up. */
export function abbreviateUuid(uuid: string): string {
  return uuid.length > UUID_PREFIX_LENGTH ? `${uuid.slice(0, UUID_PREFIX_LENGTH)}…` : uuid;
}
