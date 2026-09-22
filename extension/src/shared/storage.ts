/**
 * All ephemeral extension state, in `chrome.storage.session` exclusively —
 * never `chrome.storage.local`. Two reasons this repo pins that choice:
 *
 *   - The device token specifically: browser-boundary.md, "Pairing and
 *     token handling" — "Keep access tokens in `storage.session`" —
 *     because `storage.session`'s lifetime survives a worker going idle
 *     but not a browser restart (unlike `storage.local`, which is durable
 *     disk storage with no such expiry), and mvp-spec §7 rule 5: "Pairing
 *     tokens are device-scoped, short-lived in `storage.session`."
 *   - The last capture handoff: not itself a secret, but it is a copy of
 *     personal/job content the person chose to save, and it only needs to
 *     live long enough for Save (popup) to hand it to the options page's
 *     export view when the popup itself closed first (P07 packet: "If a
 *     popup closing on focus loss breaks the download, hand off to the
 *     options page's export view"). `storage.session`'s browser-restart
 *     wipe is a feature here, not a limitation: there is no reason this
 *     handoff value should outlive the browser session that created it.
 *
 * `chrome.storage.session` defaults to inaccessible from content scripts
 * (`setAccessLevel`) — this extension never calls `setAccessLevel`, so it
 * keeps that default, and nothing here needs content-script access anyway.
 */
import type { JobCapture } from "@workflow-catalog/contracts";

const DEVICE_TOKEN_KEY = "deviceToken";
const LAST_JOB_CAPTURE_KEY = "lastJobCapture";

/**
 * `PairResponse` (packages/contracts/src/bridge-http.ts) is `{ deviceId,
 * token }` -- the bridge never issues a device name, so there is nothing to
 * store here beyond the id itself. The options page shows an abbreviated
 * `deviceId` for the paired state (P07 packet part B, deliverable 1); a
 * contracts ask (a real device name in `PairResponse`, e.g. "Chrome on
 * macOS") is flagged in this packet's report rather than invented
 * client-side and silently treated as authoritative.
 */
export interface StoredDeviceToken {
  deviceId: string;
  token: string;
  pairedAt: string;
}

export async function getDeviceToken(): Promise<StoredDeviceToken | null> {
  const result = await chrome.storage.session.get(DEVICE_TOKEN_KEY);
  const value = result[DEVICE_TOKEN_KEY];
  return (value as StoredDeviceToken | undefined) ?? null;
}

export async function setDeviceToken(token: StoredDeviceToken): Promise<void> {
  await chrome.storage.session.set({ [DEVICE_TOKEN_KEY]: token });
}

export async function clearDeviceToken(): Promise<void> {
  await chrome.storage.session.remove(DEVICE_TOKEN_KEY);
}

export async function getLastJobCapture(): Promise<JobCapture | null> {
  const result = await chrome.storage.session.get(LAST_JOB_CAPTURE_KEY);
  const value = result[LAST_JOB_CAPTURE_KEY];
  return (value as JobCapture | undefined) ?? null;
}

export async function setLastJobCapture(capture: JobCapture): Promise<void> {
  await chrome.storage.session.set({ [LAST_JOB_CAPTURE_KEY]: capture });
}
