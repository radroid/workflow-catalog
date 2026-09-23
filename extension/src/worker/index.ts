/**
 * MV3 background service worker. Part A was deliberately minimal (no bridge
 * calls at all). Part B adds exactly one alarm: retrying the `job_capture`
 * outbox (shared/outbox.ts) when the bridge was unreachable at Save time.
 * `GET /commands` polling and the 15-minute session alarm are still out of
 * scope -- that's part C's "Session" deliverable, not part B's.
 *
 * Listeners are registered at module scope (never inside an async callback),
 * per browser-boundary.md's worker-lifecycle guidance: a service worker can
 * be evicted after ~30s idle, and Chrome only replays an alarm/message event
 * to listeners that were already registered synchronously when the worker
 * was last (re)started.
 */
import "../shared/zod-jitless";
import { bridgeClient } from "../shared/bridge-client";
import { ensureRetryAlarmIfQueued, flushOutbox, JOB_CAPTURE_RETRY_ALARM } from "../shared/outbox";

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Job Assistant service worker installed (${details.reason}).`);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== JOB_CAPTURE_RETRY_ALARM) return;
  void flushOutbox(bridgeClient);
});

// browser-boundary.md: "Check/recreate alarms on startup instead of
// assuming persistence across all supported versions." Runs once per worker
// start (module scope, not inside a listener) -- covers both a fresh
// install/reload and Chrome waking the worker back up after it was evicted
// with captures still queued from before.
void ensureRetryAlarmIfQueued();
