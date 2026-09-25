/**
 * MV3 background service worker. Part B added one alarm: retrying the
 * `job_capture` outbox (shared/outbox.ts) when the bridge was unreachable
 * at Save time. Part C adds the session side (session/):
 *
 * - the 15-minute `GET /commands` poll alarm, recreated at startup. A poll
 *   takes sessions in and sends pending reports; it never opens a tab --
 *   only a click in the side panel does (session/open.ts);
 * - `tabs.onRemoved`: a recorded session tab that closes is reported
 *   `closed`, and nothing else (session/tabs.ts);
 * - `tabs.onReplaced`: a recorded tab ID follows a tab Chrome swapped;
 * - at startup, an opening whose context stopped is marked interrupted,
 *   for the side panel to show.
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
import { recoverInterrupted } from "../session/open";
import { ensureSessionPollAlarm, onSessionPollAlarm, SESSION_POLL_ALARM } from "../session/poll-alarm";
import { onSessionTabClosed, onSessionTabReplaced } from "../session/tabs";

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Job Assistant service worker installed (${details.reason}).`);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JOB_CAPTURE_RETRY_ALARM) void flushOutbox(bridgeClient);
  else if (alarm.name === SESSION_POLL_ALARM) void onSessionPollAlarm(bridgeClient);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void onSessionTabClosed(tabId, bridgeClient);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void onSessionTabReplaced(addedTabId, removedTabId);
});

// browser-boundary.md: "Check/recreate alarms on startup instead of
// assuming persistence across all supported versions." Runs once per worker
// start (module scope, not inside a listener) -- covers both a fresh
// install/reload and Chrome waking the worker back up after it was evicted
// with captures still queued from before.
void ensureRetryAlarmIfQueued();
void ensureSessionPollAlarm();
void recoverInterrupted();
