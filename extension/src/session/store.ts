/**
 * Application sessions as this browser keeps them (P07 part C, mvp-spec
 * F9). browser-boundary.md, "Sleeping, restart, and exactly-once limits":
 * "Store current mappings in `storage.session`, whose lifetime survives
 * worker sleep but not browser restart, reload, or update. Store nonsecret
 * manifests/checkpoints in `storage.local`."
 *
 *   storage.local    wcSession:<sessionId>   the session: its manifest items, where it came from, how far
 *                                            opening got (the journal), what the runner said about each
 *                                            application, the person's choices, and every event sent
 *   storage.local    wcCommand:<commandId>   every command this browser has taken in, so a commandId is
 *                                            never opened twice, whatever the runner sends again
 *   storage.session  wcTabs:<sessionId>      the Chrome tab and group IDs opened for it
 *
 * Chrome's tab and group IDs mean something only within one browser
 * session, so they live only in `storage.session`: after a restart they
 * are gone, and nothing can act on a stale one. The durable records name
 * applications by task ID only.
 *
 * Nothing secret is stored here (the device token stays in
 * `storage.session`, shared/storage.ts). Every read-modify-write of one
 * session's two keys runs under that session's lock (shared/locks.ts), so
 * the side panel and the worker never lose each other's writes.
 */
import type { ApplicationStatusChanged, BrowserCommandResult } from "@workflow-catalog/contracts";
import { withLock } from "../shared/locks";
import type { CommandRefusal, UrlProblem } from "./policy";

export const SESSION_KEY_PREFIX = "wcSession:";
export const COMMAND_KEY_PREFIX = "wcCommand:";
export const TABS_KEY_PREFIX = "wcTabs:";

export type SessionPhase =
  /** Received, not opened yet: "Ready to open in your browser". */
  | "waiting"
  /** The journal: an opening started and holds its lock (`openLockName`). */
  | "opening"
  /** The journal says opening, but nothing holds its lock: the context that was opening it stopped. */
  | "interrupted"
  /** Opened (its tabs were recorded). */
  | "open"
  /** The extension won't open it (`refusal`). */
  | "refused";

export type ChoiceStatus = "applied" | "deferred";

/** Why a choice isn't recorded by the runner (yet). */
export type ChoiceProblem =
  | "unreachable"
  | "stale_revision"
  | "stage_moved_on"
  | "not_for_device"
  | "pairing"
  | "refused";

export interface SessionItem {
  readonly taskId: string;
  readonly jobRevision: number;
  readonly url: string;
  /** Why this item won't be opened (policy.ts). */
  readonly urlProblem?: UrlProblem;
  /** The application's revision and stage, as the runner last answered (`browser_command_result`'s and
   * `application_status_changed`'s `result`). The revision is what the next choice names. */
  readonly revision?: number;
  readonly stage?: string;
  /** What this browser last knew of the item's tab. */
  readonly tab?: "opened" | "closed" | "failed" | "skipped";
  /** The person's choice. `local`: recorded in this browser only (a session from a file). */
  readonly choice?: { readonly status: ChoiceStatus; readonly at: string; readonly outcome: "applied" | "deferred" | "already_applied" | "local" };
  readonly choiceProblem?: ChoiceProblem;
}

export type SessionEvent = BrowserCommandResult | ApplicationStatusChanged;

export interface EventEntry {
  readonly event: SessionEvent;
  /** `pending`: not answered yet (sent again, with the same eventId, until it is). */
  readonly state: "pending" | "accepted" | "refused";
  readonly at: string;
  /** The runner's refusal code, or the last failure's. */
  readonly code?: string;
}

export interface OpenAttempt {
  readonly id: string;
  readonly kind: "open" | "reopen" | "resume";
  readonly startedAt: string;
  /** The items this attempt opens, in order. */
  readonly taskIds: readonly string[];
}

export interface LocalSession {
  readonly sessionId: string;
  readonly title: string;
  readonly source: "bridge" | "file";
  /** A bridge session's command. */
  readonly commandId?: string;
  readonly deviceId?: string;
  readonly expiresAt?: string;
  readonly receivedAt: string;
  readonly phase: SessionPhase;
  readonly refusal?: CommandRefusal;
  readonly items: readonly SessionItem[];
  /** The journal of the latest opening (written before any tab is created). */
  readonly attempt?: OpenAttempt;
  readonly openedAt?: string;
  /** Every event made for this session, in order (the file bridge exports them). */
  readonly events: readonly EventEntry[];
  /** The runner won't take reports on this session any more. */
  readonly reportProblem?: "expired" | "unknown" | "not_for_device" | "refused";
}

export interface TabMap {
  /** taskId → Chrome tab ID, this browser session only. */
  readonly tabs: Readonly<Record<string, number>>;
  readonly groupId?: number;
}

const EMPTY_TABS: TabMap = { tabs: {} };

export function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function commandKey(commandId: string): string {
  return `${COMMAND_KEY_PREFIX}${commandId}`;
}

function tabsKey(sessionId: string): string {
  return `${TABS_KEY_PREFIX}${sessionId}`;
}

/** The lock that serialises every write to one session's records. */
export function sessionLockName(sessionId: string): string {
  return `wc-session:${sessionId}`;
}

/** Held for the whole of an opening: its release is how anyone else knows the opening context stopped. */
export function openLockName(sessionId: string): string {
  return `wc-open:${sessionId}`;
}

/** True for a storage key this module owns (the side panel re-renders on these). */
export function isSessionStorageKey(key: string): boolean {
  return key.startsWith(SESSION_KEY_PREFIX) || key.startsWith(TABS_KEY_PREFIX);
}

export async function readSession(sessionId: string): Promise<LocalSession | undefined> {
  const key = sessionKey(sessionId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] as LocalSession | undefined;
}

/** Every session, newest first. */
export async function listSessions(): Promise<LocalSession[]> {
  const all = await chrome.storage.local.get(null);
  const sessions: LocalSession[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SESSION_KEY_PREFIX)) sessions.push(value as LocalSession);
  }
  return sessions.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.sessionId.localeCompare(b.sessionId));
}

export async function sessionIdForCommand(commandId: string): Promise<string | undefined> {
  const key = commandKey(commandId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return typeof value === "string" ? value : undefined;
}

export async function readTabs(sessionId: string): Promise<TabMap> {
  const key = tabsKey(sessionId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TabMap | undefined) ?? EMPTY_TABS;
}

/** Every session's tab map in this browser session. */
export async function listTabMaps(): Promise<Map<string, TabMap>> {
  const all = await chrome.storage.session.get(null);
  const maps = new Map<string, TabMap>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(TABS_KEY_PREFIX)) maps.set(key.slice(TABS_KEY_PREFIX.length), value as TabMap);
  }
  return maps;
}

/** The session and task a Chrome tab was opened for, in this browser session. */
export async function taskForTab(tabId: number): Promise<{ sessionId: string; taskId: string } | undefined> {
  for (const [sessionId, map] of await listTabMaps()) {
    for (const [taskId, id] of Object.entries(map.tabs)) if (id === tabId) return { sessionId, taskId };
  }
  return undefined;
}

export interface SessionChange {
  readonly session?: LocalSession;
  readonly tabs?: TabMap;
}

/**
 * Reads one session's records, lets `change` decide the next ones, and
 * writes what it returned -- all under the session's lock. `change` returns
 * undefined to write nothing. Resolves with the records as they are
 * afterwards.
 */
export async function mutateSession(
  sessionId: string,
  change: (session: LocalSession | undefined, tabs: TabMap) => SessionChange | undefined | Promise<SessionChange | undefined>,
): Promise<{ session: LocalSession | undefined; tabs: TabMap }> {
  return withLock(sessionLockName(sessionId), async () => {
    const session = await readSession(sessionId);
    const tabs = await readTabs(sessionId);
    const next = await change(session, tabs);
    if (next?.session) await chrome.storage.local.set({ [sessionKey(sessionId)]: next.session });
    if (next?.tabs) await chrome.storage.session.set({ [tabsKey(sessionId)]: next.tabs });
    return { session: next?.session ?? session, tabs: next?.tabs ?? tabs };
  });
}

/** Records that `commandId` was taken in as `sessionId`. Never removed. */
export async function rememberCommand(commandId: string, sessionId: string): Promise<void> {
  await chrome.storage.local.set({ [commandKey(commandId)]: sessionId });
}

export function withItem(session: LocalSession, taskId: string, change: (item: SessionItem) => SessionItem): LocalSession {
  return { ...session, items: session.items.map((item) => (item.taskId === taskId ? change(item) : item)) };
}

/** A copy of `item` without the named optional fields. */
export function without<T extends object, K extends keyof T>(item: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...item };
  for (const key of keys) delete copy[key];
  return copy;
}
