/**
 * What a tab of a session does after it opened (P07 part C).
 *
 * browser-boundary.md: "Closing a tab records only that the tab closed. A
 * page claiming success is not authoritative application completion."
 *
 * - A recorded tab that closes is reported `closed` in a later
 *   `browser_command_result`, and nothing else. The runner flags it for
 *   review unless the person already chose (P06); the stage never moves.
 * - What a tab shows is never read: there is no content script and no
 *   `tabs` permission, so a "thank you for applying" page is invisible to
 *   the extension and changes nothing.
 * - Only IDs recorded in this browser session count (`storage.session`).
 *   After a restart, a tab Chrome restored has an ID nothing recorded, so
 *   closing it does nothing here.
 */
import type { BridgeClient } from "../shared/bridge-client";
import { buildReport, flushSession, withQueuedEvent } from "./report";
import { listTabMaps, mutateSession, taskForTab, withItem } from "./store";

/** `chrome.tabs.onRemoved`: a recorded tab closed. Resolves true when it was one of ours. */
export async function onSessionTabClosed(tabId: number, client: BridgeClient): Promise<boolean> {
  const found = await taskForTab(tabId);
  if (!found) return false;
  let report = false;
  await mutateSession(found.sessionId, (session, tabs) => {
    if (tabs.tabs[found.taskId] !== tabId) return undefined;
    const remaining = { ...tabs.tabs };
    delete remaining[found.taskId];
    const nextTabs = { ...tabs, tabs: remaining };
    if (!session) return { tabs: nextTabs };
    let next = withItem(session, found.taskId, (item) => ({ ...item, tab: "closed" }));
    // A later report names only this tab, queued behind the first (events go out in order). While the
    // opening is still running there is no first report yet: it will name this tab `closed` itself.
    if (session.source === "bridge" && !session.reportProblem && session.events.some((entry) => entry.event.type === "browser_command_result")) {
      next = withQueuedEvent(next, buildReport(next, [{ taskId: found.taskId, status: "closed" }], "completed"));
      report = true;
    }
    return { session: next, tabs: nextTabs };
  });
  if (report) await flushSession(found.sessionId, client);
  return true;
}

/** `chrome.tabs.onReplaced`: Chrome swapped a tab for another (a prerendered page), so the recorded ID follows it. */
export async function onSessionTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  const found = await taskForTab(removedTabId);
  if (!found) return;
  await mutateSession(found.sessionId, (session, tabs) =>
    tabs.tabs[found.taskId] === removedTabId ? { tabs: { ...tabs, tabs: { ...tabs.tabs, [found.taskId]: addedTabId } } } : undefined,
  );
}

/** The session and task the given tab was opened for, if any. */
export async function sessionTaskOfTab(tabId: number | undefined): Promise<{ sessionId: string; taskId: string } | undefined> {
  if (tabId === undefined) return undefined;
  return taskForTab(tabId);
}

/** Every recorded tab ID of one session, by task. */
export async function recordedTabs(sessionId: string): Promise<Readonly<Record<string, number>>> {
  return (await listTabMaps()).get(sessionId)?.tabs ?? {};
}

