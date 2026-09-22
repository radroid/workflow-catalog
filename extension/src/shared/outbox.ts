/**
 * `job_capture` outbox: exactly-once delivery when the bridge is
 * unreachable at Save time. P07 packet part B, deliverable 3: "When the
 * bridge is unreachable, keep the event queued in `chrome.storage.session`
 * and retry with backoff via `alarms`; it is delivered exactly once."
 *
 * Lives in `chrome.storage.session`, never a module-scope variable:
 * browser-boundary.md's worker-lifecycle guidance is explicit that the task
 * queue must not live "solely in globals," since the service worker can be
 * killed between any two statements. `alarms.create`/`alarms.get` are
 * idempotent by name, so a worker restart between `enqueueCapture` and its
 * `scheduleRetry` call just means the alarm gets (re)armed the next time
 * anything here runs -- `ensureRetryAlarmIfQueued` (called at worker
 * startup) is the explicit "check/recreate alarms on startup instead of
 * assuming persistence" this same doc asks for.
 *
 * Each capture already carries its own stable `eventId` (`crypto.randomUUID()`,
 * set once in build-job-capture.ts when the JobCapture envelope is built).
 * Queueing and every retry here resend that exact object, never minting a
 * new id -- that is what makes a retry a replay the bridge can recognize
 * (`duplicate: true`) instead of a second, distinct event.
 *
 * P07-B revision 1, B2: every entry is stored under its OWN
 * `chrome.storage.session` key (`jobCaptureOutbox:<eventId>`), not one
 * shared array under a single key. A popup's `enqueueCapture` and the
 * worker's alarm-driven `flushOutbox` run in different JS contexts (a
 * popup page and the background service worker do not share module-level
 * state, only the underlying storage), so an in-memory lock around a
 * shared array could never fix a race between them anyway. A single-array
 * design already lost a real capture this way: `flushOutbox` reads the
 * whole list, awaits a `postEvent` per entry (real network time), then
 * writes back its own -- by then stale -- idea of what should remain; a
 * capture `enqueueCapture` added to the real list while that await was in
 * flight was silently overwritten out of existence. Per-key storage makes
 * that impossible by construction: every mutation here touches exactly one
 * entry's own key (`chrome.storage.session.set`/`.remove` on a single key),
 * never a whole-list read-modify-write, so an entry enqueued mid-flush
 * simply exists under its own key the whole time and is never touched by
 * another entry's delivery/removal.
 *
 * P07-B revision 2 closes the races that per-key storage alone left open,
 * all between two JS contexts working on the same queue at once (the
 * worker's alarm flush, a popup's Save, the options page's flush after a
 * pairing):
 *
 * - B1: the retry alarm is decided from a fresh read after the flush, and
 *   re-checked after clearing it (`rearmOrClearRetryAlarm`), so an entry
 *   queued mid-flush always keeps an alarm.
 * - B2: a successful pairing lifts every pause first, arms the alarm, then
 *   flushes (`resumeAfterPairing`), and an entry that fails with a
 *   retryable error loses its pause; a pause can no longer outlive the
 *   pairing that ended it.
 * - An entry is only ever written back if it is still queued
 *   (`rewriteIfStillQueued`), so a flush can't resurrect a capture another
 *   context delivered and removed while this one's request was in flight.
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { BridgeClient, BridgeError } from "./bridge-client";

const OUTBOX_KEY_PREFIX = "jobCaptureOutbox:";
export const JOB_CAPTURE_RETRY_ALARM = "job-capture-retry";

/** Set (to `true`) the first time a capture is queued in this browser
 * session, and never cleared by this module -- lets the options page tell
 * "everything that had to wait was sent" apart from "nothing was ever
 * queued" (P07-B revision 2 polish: "All saved jobs sent." no longer shows
 * on a fresh install). Deliberately not under OUTBOX_KEY_PREFIX. */
const OUTBOX_USED_KEY = "jobCaptureOutboxUsedThisSession";

function outboxKey(eventId: string): string {
  return `${OUTBOX_KEY_PREFIX}${eventId}`;
}

/** True for a `chrome.storage.onChanged` key that is (or was) one of this
 * module's entries -- lets the options page refresh its outbox line
 * without knowing the key layout. */
export function isOutboxStorageKey(key: string): boolean {
  return key.startsWith(OUTBOX_KEY_PREFIX) || key === OUTBOX_USED_KEY;
}

/**
 * browser-boundary.md: "Chrome 120 permits 30-second periods" for an
 * extension loaded unpacked; a packed install may clamp a very short delay
 * up to Chrome's ordinary one-minute alarm floor. Either way this is a
 * reasonable first retry for a background sync no person is watching.
 */
const FIRST_RETRY_DELAY_MINUTES = 0.5;
const MAX_RETRY_DELAY_MINUTES = 30;
const BACKOFF_FACTOR = 2;

export interface OutboxEntry {
  readonly capture: JobCapture;
  readonly attempts: number;
  readonly queuedAt: string;
  /**
   * P07-B revision 1, B3: set (to the bridge's own error code, e.g.
   * `not_paired`, `token_invalid` or `origin_not_allowed`) once a failure
   * that only a person can fix has been seen for this entry -- see
   * `failureAction`. A paused entry stays queued (nothing here ever
   * silently drops a capture just because the token/origin was wrong) but
   * is skipped by `flushOutbox` until a fresh pairing lifts the pause
   * (`resumeAfterPairing`) -- retrying the exact same request against the
   * exact same dead token/origin could only ever repeat the same refusal.
   */
  readonly pausedReason?: string;
  /** P07-B revision 2, B3: the code of the most recent failed attempt that
   * left this entry queued, so the options page can say why it's waiting
   * (e.g. `invalid_response`: something other than the runner answered on
   * its port). */
  readonly lastErrorCode?: string;
}

/**
 * What to do with a capture after a delivery attempt failed with `error`.
 * One classification for both the popup's Save and the background flush,
 * so the two can never disagree about the same failure.
 *
 * - `pause`: only a person can fix it -- no pairing yet (`not_paired`), or
 *   the bridge itself refused this device's token (401) or origin (403) in
 *   its own error envelope. Kept, not retried until a fresh pairing.
 * - `retry`: nothing -- or nothing that is this bridge -- has the capture
 *   yet, so keep it and back off: `network_error` (connection refused, or
 *   no answer within the timeout), a 5xx, `invalid_response` (a 200 that
 *   isn't the bridge's answer to this event, e.g. another program on the
 *   port), `unknown_error` (an error that isn't in the bridge's envelope --
 *   again not this bridge), or `token_replaced` (a new pairing replaced the
 *   token mid-request; see bridge-client.ts). P07-B revision 2, B3: the
 *   last three used to be dropped, deleting captures no bridge ever
 *   received.
 * - `drop`: the bridge itself refused this exact request, in its own
 *   envelope (400, 409, 413, 415, 422, ...). Resending it can never
 *   succeed; the popup shows the bridge's message and offers the file
 *   export instead.
 */
export type FailureAction = "pause" | "retry" | "drop";

export function failureAction(error: BridgeError): FailureAction {
  if (error.code === "not_paired") return "pause";
  const fromThisBridge = error.code !== "unknown_error";
  if (fromThisBridge && (error.status === 401 || error.status === 403)) return "pause";
  if (
    error.code === "network_error" ||
    error.code === "invalid_response" ||
    error.code === "unknown_error" ||
    error.code === "token_replaced" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "retry";
  }
  return "drop";
}

/** Oldest first: by `queuedAt`, then by when the capture itself was made
 * (`occurredAt`), then by `eventId` -- so captures queued in the same
 * millisecond still flush in one fixed order (P07-B revision 2 nit). */
function compareEntries(a: OutboxEntry, b: OutboxEntry): number {
  return (
    a.queuedAt.localeCompare(b.queuedAt) ||
    a.capture.occurredAt.localeCompare(b.capture.occurredAt) ||
    a.capture.eventId.localeCompare(b.capture.eventId)
  );
}

/** Every stored `chrome.storage.session` key/value this module owns,
 * without assuming anything about read ordering: `get(null)` (this
 * extension's one other storage consumer, shared/storage.ts, uses distinct
 * key names, so a plain prefix filter is exact, not just a heuristic). */
async function readOutbox(): Promise<OutboxEntry[]> {
  const all = await chrome.storage.session.get(null);
  const entries: OutboxEntry[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(OUTBOX_KEY_PREFIX)) entries.push(value as OutboxEntry);
  }
  // storage.session.get(null) makes no ordering promise.
  return entries.sort(compareEntries);
}

/** An entry with no `undefined`-valued optional fields, so what's stored
 * is exactly what's meant (no lingering `pausedReason: undefined`). */
function makeEntry(fields: {
  capture: JobCapture;
  attempts: number;
  queuedAt: string;
  pausedReason?: string | undefined;
  lastErrorCode?: string | undefined;
}): OutboxEntry {
  const { pausedReason, lastErrorCode, ...required } = fields;
  return {
    ...required,
    ...(pausedReason !== undefined ? { pausedReason } : {}),
    ...(lastErrorCode !== undefined ? { lastErrorCode } : {}),
  };
}

async function writeEntry(entry: OutboxEntry): Promise<void> {
  await chrome.storage.session.set({ [outboxKey(entry.capture.eventId)]: entry });
}

async function readEntry(eventId: string): Promise<OutboxEntry | undefined> {
  const result = await chrome.storage.session.get(outboxKey(eventId));
  return result[outboxKey(eventId)] as OutboxEntry | undefined;
}

async function removeEntry(eventId: string): Promise<void> {
  await chrome.storage.session.remove(outboxKey(eventId));
}

/** Rewrites `eventId`'s entry as `update(current)` -- but only if it is
 * still queued. Another context may have delivered and removed it while
 * this one's own request for it was in flight (the options page's flush
 * after a pairing, racing the worker's alarm flush): writing a stale copy
 * back would resurrect a delivered capture. chrome.storage has no
 * compare-and-set, so a window of one storage round trip remains between
 * the read and the write; the race this closes spans a whole network
 * request. */
async function rewriteIfStillQueued(eventId: string, update: (current: OutboxEntry) => OutboxEntry): Promise<void> {
  const current = await readEntry(eventId);
  if (current) await writeEntry(update(current));
}

/** Every capture still waiting to be delivered, oldest first. */
export async function listQueuedCaptures(): Promise<OutboxEntry[]> {
  return readOutbox();
}

export async function isQueued(eventId: string): Promise<boolean> {
  return (await readEntry(eventId)) !== undefined;
}

/** True once any capture has been queued in this browser session (see
 * OUTBOX_USED_KEY). */
export async function outboxUsedThisSession(): Promise<boolean> {
  const result = await chrome.storage.session.get(OUTBOX_USED_KEY);
  return result[OUTBOX_USED_KEY] === true;
}

function delayForAttempt(attemptsAlreadyMade: number): number {
  const exponent = Math.max(0, attemptsAlreadyMade - 1);
  return Math.min(FIRST_RETRY_DELAY_MINUTES * BACKOFF_FACTOR ** exponent, MAX_RETRY_DELAY_MINUTES);
}

async function scheduleRetry(attemptsAlreadyMade: number): Promise<void> {
  await chrome.alarms.create(JOB_CAPTURE_RETRY_ALARM, { delayInMinutes: delayForAttempt(attemptsAlreadyMade) });
}

function activeEntries(entries: readonly OutboxEntry[]): OutboxEntry[] {
  return entries.filter((entry) => !entry.pausedReason);
}

function mostAttempts(entries: readonly OutboxEntry[]): number {
  return Math.max(1, ...entries.map((entry) => entry.attempts));
}

/**
 * P07-B revision 2, B1: arms the retry alarm if any entry is actively
 * waiting, clears it otherwise -- decided from a fresh read, never from a
 * flush's own bookkeeping. Revision 1 cleared the alarm without looking
 * whenever its own pass had nothing left to retry, which wiped the alarm a
 * popup had just armed for a capture it queued mid-flush: that capture then
 * sat in the queue until something else woke the worker, and was lost when
 * Chrome quit (the outbox lives in storage.session).
 *
 * The clear is followed by one more read: `enqueueCapture` writes its entry
 * before it arms the alarm, so any alarm this clear could have removed
 * belongs to an entry the second read sees, and gets re-armed. Returns the
 * number of entries still queued (active or paused).
 */
async function rearmOrClearRetryAlarm(): Promise<number> {
  const entries = await readOutbox();
  const active = activeEntries(entries);
  if (active.length > 0) {
    await scheduleRetry(mostAttempts(active));
    return entries.length;
  }
  await chrome.alarms.clear(JOB_CAPTURE_RETRY_ALARM);
  const late = await readOutbox();
  const lateActive = activeEntries(late);
  if (lateActive.length > 0) await scheduleRetry(mostAttempts(lateActive));
  return late.length;
}

/**
 * Queues `capture` (a no-op if it's already queued -- idempotent by
 * eventId, so a caller never has to check first) after a live `postEvent`
 * attempt failed with `initialError`, and arms the retry alarm -- unless
 * that failure is one only a person can fix (`failureAction` says `pause`),
 * in which case the capture is queued paused, with no alarm for it. Save
 * itself always tries the bridge first (P07 packet: "keep the event queued
 * ... [when] the bridge is unreachable", not unconditionally), and never
 * queues a `drop` failure.
 *
 * P07-B revision 1, E2: a capture made while not paired is queued here too
 * (paused, the same as a 401/403) and delivered automatically once pairing
 * succeeds (`resumeAfterPairing`).
 */
export async function enqueueCapture(capture: JobCapture, initialError?: BridgeError): Promise<void> {
  await chrome.storage.session.set({ [OUTBOX_USED_KEY]: true });
  if (await isQueued(capture.eventId)) return;
  const pausedReason = initialError && failureAction(initialError) === "pause" ? initialError.code : undefined;
  await writeEntry(
    makeEntry({ capture, attempts: 0, queuedAt: new Date().toISOString(), pausedReason, lastErrorCode: initialError?.code }),
  );
  if (!pausedReason) await scheduleRetry(1);
}

export interface FlushSummary {
  readonly delivered: readonly string[];
  /** Entries still queued once this flush finished (active or paused), from
   * a fresh read -- including any another context queued meanwhile. */
  readonly stillPending: number;
}

/**
 * Attempts every queued, not-paused capture once, in order, against
 * `client`. A capture the bridge accepts -- including a replay it reports
 * `duplicate: true` for (runner/README.md: "Replay ... gets the stored
 * outcome back with duplicate: true") -- is removed from the queue. What
 * happens after a failure is `failureAction`'s call: `retry` keeps it
 * active (attempt count bumped, pause cleared -- B2), `pause` keeps it
 * paused, `drop` removes it. One entry failing can never wedge the rest:
 * every entry gets its own `postEvent` call and its own, single-key
 * storage write -- see this file's header for why that is what makes a
 * capture queued mid-flush by a *different* JS context impossible to lose
 * (B2 of revision 1), and `rewriteIfStillQueued` for why a failure is never
 * written back over a capture someone else already delivered.
 *
 * The retry alarm is then armed or cleared from a fresh read
 * (`rearmOrClearRetryAlarm`, B1 of revision 2).
 */
export async function flushOutbox(client: BridgeClient): Promise<FlushSummary> {
  const entries = await readOutbox();
  const delivered: string[] = [];

  for (const entry of entries) {
    if (entry.pausedReason) continue;
    const eventId = entry.capture.eventId;
    const result = await client.postEvent(entry.capture);
    if (result.ok) {
      await removeEntry(eventId);
      delivered.push(eventId);
      continue;
    }
    const action = failureAction(result.error);
    if (action === "drop") {
      await removeEntry(eventId);
      continue;
    }
    await rewriteIfStillQueued(eventId, (current) =>
      makeEntry({
        capture: current.capture,
        queuedAt: current.queuedAt,
        attempts: current.attempts + 1,
        // B2 (revision 2): a retryable failure clears any pause -- a
        // pause carried forward here outlived the pairing that lifted it.
        pausedReason: action === "pause" ? result.error.code : undefined,
        lastErrorCode: result.error.code,
      }),
    );
  }

  const stillPending = await rearmOrClearRetryAlarm();
  return { delivered, stillPending };
}

/**
 * P07-B revision 2, B2: what a successful pairing does with the outbox, in
 * this order --
 *   1. lift every pause in storage: a fresh pairing is exactly the event
 *      that can make a `not_paired`/401/403 pause stale;
 *   2. arm the retry alarm, if anything is queued;
 *   3. flush once, right away.
 * Steps 1 and 2 come first so that if the page running this (the options
 * page) closes mid-flush, every entry is already active and the worker's
 * alarm delivers the rest. Revision 1 flushed with an `includePaused`
 * option instead: the pause only lifted in memory for that one pass, so
 * one transient failure in it left the entry paused again, and closing the
 * page mid-flush left every entry after it paused until the next pairing.
 */
export async function resumeAfterPairing(client: BridgeClient): Promise<FlushSummary> {
  for (const entry of await readOutbox()) {
    if (!entry.pausedReason) continue;
    await rewriteIfStillQueued(entry.capture.eventId, (current) =>
      makeEntry({
        capture: current.capture,
        queuedAt: current.queuedAt,
        attempts: current.attempts,
        lastErrorCode: current.lastErrorCode,
      }),
    );
  }
  if ((await readOutbox()).length > 0) await scheduleRetry(1);
  return flushOutbox(client);
}

/**
 * Called once when the worker starts (module scope -- see worker/index.ts).
 * If a restart or update left captures queued from before, this makes sure
 * a retry alarm actually exists for them, rather than assuming the alarm
 * that was live before the restart still is (browser-boundary.md: "Check/
 * recreate alarms on startup instead of assuming persistence across all
 * supported versions").
 */
export async function ensureRetryAlarmIfQueued(): Promise<void> {
  const entries = await readOutbox();
  // A worker restart with nothing but paused entries queued needs no
  // alarm at all: flushOutbox skips every one of them anyway, so arming one
  // here would just fire and immediately clear itself for no reason.
  if (activeEntries(entries).length === 0) return;
  const existing = await chrome.alarms.get(JOB_CAPTURE_RETRY_ALARM);
  if (!existing) await scheduleRetry(1);
}
