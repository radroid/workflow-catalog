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
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { BridgeClient, BridgeError } from "./bridge-client";

const OUTBOX_KEY_PREFIX = "jobCaptureOutbox:";
export const JOB_CAPTURE_RETRY_ALARM = "job-capture-retry";

function outboxKey(eventId: string): string {
  return `${OUTBOX_KEY_PREFIX}${eventId}`;
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
   * `token_invalid` or `origin_not_allowed`) once a 401 or 403 has been
   * seen for this entry. A paused entry stays queued (nothing here ever
   * silently drops a capture just because the token/origin was wrong) but
   * is skipped by `flushOutbox` until a fresh pairing calls it again (E2) --
   * retrying the exact same request against the exact same dead
   * token/origin could only ever repeat the same refusal.
   */
  readonly pausedReason?: string;
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
  // storage.session.get(null) makes no ordering promise; every caller here
  // wants "oldest queued first" (a stable, meaningful order over an
  // otherwise-unordered key/value bag), from each entry's own queuedAt.
  return entries.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

async function writeEntry(entry: OutboxEntry): Promise<void> {
  await chrome.storage.session.set({ [outboxKey(entry.capture.eventId)]: entry });
}

async function removeEntry(eventId: string): Promise<void> {
  await chrome.storage.session.remove(outboxKey(eventId));
}

/** Every capture still waiting to be delivered, oldest first. */
export async function listQueuedCaptures(): Promise<OutboxEntry[]> {
  return readOutbox();
}

export async function isQueued(eventId: string): Promise<boolean> {
  const result = await chrome.storage.session.get(outboxKey(eventId));
  return outboxKey(eventId) in result;
}

function delayForAttempt(attemptsAlreadyMade: number): number {
  const exponent = Math.max(0, attemptsAlreadyMade - 1);
  return Math.min(FIRST_RETRY_DELAY_MINUTES * BACKOFF_FACTOR ** exponent, MAX_RETRY_DELAY_MINUTES);
}

async function scheduleRetry(attemptsAlreadyMade: number): Promise<void> {
  await chrome.alarms.create(JOB_CAPTURE_RETRY_ALARM, { delayInMinutes: delayForAttempt(attemptsAlreadyMade) });
}

/**
 * Queues `capture` (a no-op if it's already queued -- idempotent by
 * eventId, so a caller never has to check first) and arms the retry alarm
 * -- unless `initialError` is already a pausing one (see `isPausingError`),
 * in which case the capture is queued but no alarm is armed for it yet,
 * the same state `flushOutbox` itself leaves a newly-paused entry in.
 * Called only after a live `postEvent` attempt has already failed; Save
 * itself always tries the bridge first (P07 packet: "keep the event
 * queued ... [when] the bridge is unreachable", not unconditionally).
 *
 * P07-B revision 1, E2: a capture made while not paired is queued here too
 * now (part A's original design deliberately never queued a not_paired
 * failure, on the theory that an unbounded queue-before-ever-pairing was a
 * silent trap -- the orchestrator's E2 decision supersedes that: it is
 * queued, paused the same way a 401/403 is, and delivered automatically
 * once pairing succeeds, which explicitly flushes with `includePaused`).
 */
export async function enqueueCapture(capture: JobCapture, initialError?: BridgeError): Promise<void> {
  if (await isQueued(capture.eventId)) return;
  const pausedReason = initialError && isPausingError(initialError) ? initialError.code : undefined;
  await writeEntry({ capture, attempts: 0, queuedAt: new Date().toISOString(), pausedReason });
  if (!pausedReason) await scheduleRetry(1);
}

export interface FlushSummary {
  readonly delivered: readonly string[];
  readonly stillPending: number;
}

/** `not_paired` (no token stored at all), 401 (token_invalid), or 403
 * (origin_not_allowed/origin_required): the exact same request against the
 * exact same missing/dead token or wrong origin can only ever repeat the
 * same refusal (P07-B revision 1, B3 and E2) -- pause, don't spend another
 * alarm on it until a fresh pairing (E2's flush-on-pair) proves something
 * actually changed. */
function isPausingError(error: BridgeError): boolean {
  return error.code === "not_paired" || error.status === 401 || error.status === 403;
}

/** network_error (no HTTP response at all: connection refused or the
 * request timed out, see bridge-client.ts) or any 5xx: the runner may
 * simply be starting up or briefly overloaded, so keep retrying
 * automatically (P07-B revision 1, B3). Checked by code/status
 * explicitly, not just "no status", so invalid_response (something
 * answered on the port but not shaped like this bridge -- see
 * bridge-client.ts's postEvent) falls through to the drop branch below
 * instead of being retried forever: a wrong process on the port will keep
 * answering the same wrong way. */
function isRetryableFailure(error: BridgeError): boolean {
  return error.code === "network_error" || (error.status !== undefined && error.status >= 500);
}

/**
 * Attempts every queued, not-currently-paused capture once, in order,
 * against `client`. A capture the bridge accepts -- including a replay it
 * reports `duplicate: true` for (runner/README.md: "Replay ... gets the
 * stored outcome back with duplicate: true") -- is removed from the queue.
 * A network/5xx failure stays queued for the next alarm, attempt count
 * bumped, fresh backoff. A 401/403 stays queued too, but paused (see
 * `isPausingStatus`) -- not attempted again by this function until it's no
 * longer paused. Any other 4xx (400, 409, 413, 415, 422, ...) is dropped:
 * resending an identical, already-refused request cannot ever succeed.
 * One entry failing can never wedge the rest: every entry gets its own
 * `postEvent` call and its own, single-key storage write -- see this
 * file's header for why that (not a whole-list read-modify-write) is what
 * makes a capture queued mid-flush by a *different* JS context (a popup's
 * `enqueueCapture`, while the worker's alarm-driven flush is still
 * awaiting an earlier entry's `postEvent`) impossible to lose (B2).
 *
 * `includePaused` (P07-B revision 1, E2 + B3's "after a new pairing,
 * flush"): a fresh, successful pairing is exactly the event that can make
 * a previously-paused entry's `pausedReason` stale (a new token, or one
 * presented from the right origin this time), so the caller that just
 * paired (options/main.ts) passes `true` here to give every paused entry
 * one more real attempt instead of leaving it paused indefinitely. The
 * alarm-driven call from worker/index.ts never does -- nothing there ever
 * proves a pause reason stopped applying.
 */
export async function flushOutbox(client: BridgeClient, options: { includePaused?: boolean } = {}): Promise<FlushSummary> {
  const entries = await readOutbox();
  const delivered: string[] = [];
  let stillPending = 0;
  let hasActiveRetries = false;

  for (const entry of entries) {
    if (entry.pausedReason && !options.includePaused) {
      stillPending += 1;
      continue;
    }
    const result = await client.postEvent(entry.capture);
    if (result.ok) {
      await removeEntry(entry.capture.eventId);
      delivered.push(entry.capture.eventId);
      continue;
    }
    stillPending += 1;
    if (isRetryableFailure(result.error)) {
      await writeEntry({ ...entry, attempts: entry.attempts + 1 });
      hasActiveRetries = true;
    } else if (isPausingError(result.error)) {
      await writeEntry({ ...entry, attempts: entry.attempts + 1, pausedReason: result.error.code });
    } else {
      await removeEntry(entry.capture.eventId);
      stillPending -= 1;
    }
  }

  // Re-read rather than trust this pass's own local bookkeeping: a
  // still-paused entry from before this call, or one a concurrent
  // enqueueCapture added while the loop above was awaiting, is real
  // current state this decision must see (the exact case B2 covers).
  if (hasActiveRetries) {
    const active = (await readOutbox()).filter((entry) => !entry.pausedReason);
    const mostAttempts = active.length > 0 ? Math.max(...active.map((entry) => entry.attempts)) : 1;
    await scheduleRetry(mostAttempts);
  } else {
    await chrome.alarms.clear(JOB_CAPTURE_RETRY_ALARM);
  }
  return { delivered, stillPending };
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
  // alarm at all: flushOutbox's own default (includePaused: false) would
  // skip every one of them anyway, so arming one here would just fire and
  // immediately clear itself for no reason.
  if (!entries.some((entry) => !entry.pausedReason)) return;
  const existing = await chrome.alarms.get(JOB_CAPTURE_RETRY_ALARM);
  if (!existing) await scheduleRetry(1);
}
