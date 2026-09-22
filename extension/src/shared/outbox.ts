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
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { BridgeClient } from "./bridge-client";

const OUTBOX_KEY = "jobCaptureOutbox";
export const JOB_CAPTURE_RETRY_ALARM = "job-capture-retry";

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
}

async function readOutbox(): Promise<OutboxEntry[]> {
  const result = await chrome.storage.session.get(OUTBOX_KEY);
  const value = result[OUTBOX_KEY];
  return Array.isArray(value) ? (value as OutboxEntry[]) : [];
}

async function writeOutbox(entries: OutboxEntry[]): Promise<void> {
  await chrome.storage.session.set({ [OUTBOX_KEY]: entries });
}

/** Every capture still waiting to be delivered, oldest first. */
export async function listQueuedCaptures(): Promise<OutboxEntry[]> {
  return readOutbox();
}

export async function isQueued(eventId: string): Promise<boolean> {
  return (await readOutbox()).some((entry) => entry.capture.eventId === eventId);
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
 * eventId, so a caller never has to check first) and arms the retry alarm.
 * Called only after a live `postEvent` attempt has already failed; Save
 * itself always tries the bridge first (P07 packet: "keep the event queued
 * ... [when] the bridge is unreachable", not unconditionally).
 */
export async function enqueueCapture(capture: JobCapture): Promise<void> {
  const entries = await readOutbox();
  if (entries.some((entry) => entry.capture.eventId === capture.eventId)) return;
  entries.push({ capture, attempts: 0, queuedAt: new Date().toISOString() });
  await writeOutbox(entries);
  await scheduleRetry(1);
}

export interface FlushSummary {
  readonly delivered: readonly string[];
  readonly stillPending: number;
}

/**
 * Attempts every queued capture once, in order, against `client`. A capture
 * the bridge accepts -- including a replay it reports `duplicate: true`
 * for, which still counts as delivered (runner/README.md: "Replay ...
 * gets the stored outcome back with duplicate: true") -- is removed from
 * the queue. Anything else stays queued for the next alarm, with its
 * attempt count bumped and a fresh backoff. One entry failing can never
 * wedge the rest: every entry gets its own `postEvent` call, and a thrown
 * error from the client itself (there should be none -- BridgeClient never
 * throws) would only be caught by the caller's own alarm handler, not lose
 * entries already processed in this pass.
 */
export async function flushOutbox(client: BridgeClient): Promise<FlushSummary> {
  const entries = await readOutbox();
  const delivered: string[] = [];
  const remaining: OutboxEntry[] = [];

  for (const entry of entries) {
    const result = await client.postEvent(entry.capture);
    if (result.ok) {
      delivered.push(entry.capture.eventId);
    } else {
      remaining.push({ ...entry, attempts: entry.attempts + 1 });
    }
  }

  await writeOutbox(remaining);
  if (remaining.length > 0) {
    const mostAttempts = Math.max(...remaining.map((entry) => entry.attempts));
    await scheduleRetry(mostAttempts);
  } else {
    await chrome.alarms.clear(JOB_CAPTURE_RETRY_ALARM);
  }
  return { delivered, stillPending: remaining.length };
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
  if (entries.length === 0) return;
  const existing = await chrome.alarms.get(JOB_CAPTURE_RETRY_ALARM);
  if (!existing) await scheduleRetry(1);
}
