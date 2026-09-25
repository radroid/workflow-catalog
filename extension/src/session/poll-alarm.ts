/**
 * The worker's side of sessions (P07 part C): "poll `GET /commands` on
 * panel open and via an alarm (15-minute cadence, recreated on startup)".
 *
 * browser-boundary.md: "Alarms can be delayed, do not wake sleeping
 * devices, and missed repeating alarms coalesce ... Check/recreate alarms
 * on startup instead of assuming persistence across all supported
 * versions." A poll only takes sessions in and sends what is pending; it
 * never opens a tab (open.ts runs only from a click in the side panel), so
 * a laptop waking up to a queue of sessions shows them, and floods nothing.
 */
import type { BridgeClient } from "../shared/bridge-client";
import { recoverInterrupted } from "./open";
import { pollCommands, type PollOutcome } from "./receive";

export const SESSION_POLL_ALARM = "session-poll";
export const SESSION_POLL_PERIOD_MINUTES = 15;

/** Creates the repeating poll alarm unless it already exists with the right period. */
export async function ensureSessionPollAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SESSION_POLL_ALARM);
  if (existing && existing.periodInMinutes === SESSION_POLL_PERIOD_MINUTES) return;
  await chrome.alarms.create(SESSION_POLL_ALARM, { delayInMinutes: SESSION_POLL_PERIOD_MINUTES, periodInMinutes: SESSION_POLL_PERIOD_MINUTES });
}

/** The alarm fired: recover interrupted openings, poll, then make sure the alarm repeats. Opens nothing. */
export async function onSessionPollAlarm(client: BridgeClient): Promise<PollOutcome> {
  await recoverInterrupted();
  try {
    return await pollCommands(client);
  } finally {
    await ensureSessionPollAlarm();
  }
}
