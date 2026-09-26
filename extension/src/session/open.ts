/**
 * Opening a session as a tab group (P07 part C, mvp-spec F9). Only a
 * person's click in the side panel calls these; the worker's alarm never
 * does (browser-boundary.md: "a scheduled run ... cannot open tabs on an
 * unavailable computer. Show 'Ready to open in your browser,' then open a
 * group after the user selects Start applying").
 *
 * browser-boundary.md: "There is no transaction spanning browser tab
 * creation and our database. A crash after creating a tab but before
 * recording its ID creates uncertainty. Never promise exactly-once
 * opening. Journal intent first, record returned IDs, deduplicate
 * completed commands, and surface unresolved partial sessions for user
 * review instead of blindly replaying them." So, in this order, each step
 * a checkpoint in storage:
 *
 *   1. take the session's open lock (held until the end; see `recoverInterrupted`)
 *   2. journal: phase `opening` and the attempt (which items, in order)   storage.local
 *   3. per item: create its tab, then record the returned tab ID          storage.session
 *   4. group the recorded tabs, record the group ID, then name the group  storage.session
 *   5. phase `open`, and the report queued in the same write              storage.local
 *   6. send the report
 *
 * If the context doing this stops anywhere between 2 and 5, the lock is
 * released with it and the journal still says `opening`: the side panel
 * and the worker then mark the session `interrupted`, and the panel shows
 * what was recorded and asks the person what to do. Nothing reopens on its
 * own. A tab created in the gap between 3's two halves is the one thing
 * that can be open without being recorded; the panel says so.
 *
 * Every URL is checked again right before its tab is created (policy.ts).
 * Tabs are created without the `tabs` permission: `tabs.create`,
 * `tabs.group` and `tabGroups.update` need none beyond `tabGroups`.
 */
import type { BridgeClient } from "../shared/bridge-client";
import { isLockFree, withLockIfFree } from "../shared/locks";
import { openableUrlProblem } from "./policy";
import { buildReport, firstReportItems, flushSession, hasFirstReport, withQueuedEvent } from "./report";
import { listSessions, mutateSession, openLockName, readSession, withItem, type LocalSession, type OpenAttempt, type TabMap } from "./store";

/** The browser calls opening makes, so tests can stand in for Chrome. */
export interface TabsApi {
  createTab(url: string, active: boolean): Promise<number>;
  groupTabs(tabIds: readonly number[]): Promise<number>;
  nameGroup(groupId: number, title: string): Promise<void>;
  /** How many tab groups in this browser already carry `title`. */
  groupsTitled(title: string): Promise<number>;
  tabExists(tabId: number): Promise<boolean>;
}

/** Chrome's own calls, looked up at call time (never captured at import). */
export const chromeTabsApi: TabsApi = {
  async createTab(url, active) {
    const tab = await chrome.tabs.create({ url, active });
    if (tab.id === undefined) throw new Error("Chrome created a tab without an id.");
    return tab.id;
  },
  async groupTabs(tabIds) {
    const [first, ...rest] = tabIds;
    if (first === undefined) throw new Error("No tabs to group.");
    return chrome.tabs.group({ tabIds: [first, ...rest] });
  },
  async nameGroup(groupId, title) {
    await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: false });
  },
  async groupsTitled(title) {
    return (await chrome.tabGroups.query({ title })).length;
  },
  async tabExists(tabId) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
};

export type OpenKind = OpenAttempt["kind"];

export type OpenOutcome =
  | { readonly kind: "opened"; readonly opened: number; readonly failed: number; readonly grouped: boolean }
  | { readonly kind: "busy" }
  | { readonly kind: "not_now" }
  | { readonly kind: "expired" }
  | { readonly kind: "same_title"; readonly groups: number }
  | { readonly kind: "nothing_to_open" }
  | { readonly kind: "gone" };

const PHASE_FOR: Readonly<Record<OpenKind, LocalSession["phase"]>> = {
  open: "waiting",
  reopen: "open",
  resume: "interrupted",
};

function tasksToOpen(session: LocalSession, tabs: TabMap, kind: OpenKind): string[] {
  return session.items
    .filter((item) => item.urlProblem === undefined)
    .filter((item) => kind !== "resume" || tabs.tabs[item.taskId] === undefined)
    .map((item) => item.taskId);
}

export interface OpenOptions {
  readonly api?: TabsApi;
  /** Reopen only: the person saw the same-title warning and chose to open a new group anyway. */
  readonly confirmSameTitle?: boolean;
  readonly now?: () => Date;
}

/**
 * `open`: a waiting session, first time. `reopen`: an opened session
 * whose tabs are gone (a browser restart, or closed), from its manifest,
 * into a new group, never adopting tabs that happen to be open (a group
 * with the same title makes it ask first). `resume`: an interrupted
 * opening, only the items with no recorded tab.
 */
export async function openSession(sessionId: string, kind: OpenKind, client: BridgeClient, options: OpenOptions = {}): Promise<OpenOutcome> {
  const api = options.api ?? chromeTabsApi;
  const now = options.now ?? (() => new Date());
  const locked = await withLockIfFree(openLockName(sessionId), async (): Promise<OpenOutcome> => {
    const before = await readSession(sessionId);
    if (!before) return { kind: "gone" };
    if (before.phase !== PHASE_FOR[kind]) return { kind: "not_now" };
    if (kind === "open" && before.source === "bridge" && before.expiresAt && new Date(before.expiresAt).getTime() <= now().getTime()) {
      await mutateSession(sessionId, (session) => (session?.phase === "waiting" ? { session: { ...session, phase: "refused", refusal: "expired" } } : undefined));
      return { kind: "expired" };
    }
    if (kind === "reopen" && !options.confirmSameTitle) {
      const groups = await api.groupsTitled(before.title);
      if (groups > 0) return { kind: "same_title", groups };
    }

    // 2. The journal, before any tab exists.
    const attemptId = crypto.randomUUID();
    const journaled = await mutateSession(sessionId, (session, tabs) => {
      if (!session || session.phase !== PHASE_FOR[kind]) return undefined;
      const taskIds = tasksToOpen(session, tabs, kind);
      if (taskIds.length === 0) return undefined;
      const attempt: OpenAttempt = { id: attemptId, kind, startedAt: now().toISOString(), taskIds };
      // A reopen starts a new group: the old IDs belong to tabs that are gone, or to ones it must not adopt.
      return { session: { ...session, phase: "opening", attempt }, ...(kind === "reopen" ? { tabs: { tabs: {} } } : {}) };
    });
    const attempt = journaled.session?.attempt;
    if (journaled.session?.phase !== "opening" || attempt?.id !== attemptId) return { kind: "nothing_to_open" };

    // 3. Each tab: create, then record.
    let opened = 0;
    let failed = 0;
    for (const [index, taskId] of attempt.taskIds.entries()) {
      const item = journaled.session.items.find((candidate) => candidate.taskId === taskId);
      if (!item) continue;
      const problem = openableUrlProblem(item.url);
      if (problem) {
        await mutateSession(sessionId, (session) => (session ? { session: withItem(session, taskId, (entry) => ({ ...entry, urlProblem: problem })) } : undefined));
        continue;
      }
      let tabId: number;
      try {
        tabId = await api.createTab(item.url, index === 0);
      } catch {
        failed += 1;
        await mutateSession(sessionId, (session) => (session ? { session: withItem(session, taskId, (entry) => ({ ...entry, tab: "failed" })) } : undefined));
        continue;
      }
      await mutateSession(sessionId, (session, tabs) =>
        session ? { session: withItem(session, taskId, (entry) => ({ ...entry, tab: "opened" })), tabs: { ...tabs, tabs: { ...tabs.tabs, [taskId]: tabId } } } : undefined,
      );
      opened += 1;
    }

    // 4. The group: every recorded tab of this session that still exists.
    let grouped = false;
    const recorded = (await mutateSession(sessionId, () => undefined)).tabs;
    const live: number[] = [];
    for (const tabId of Object.values(recorded.tabs)) if (await api.tabExists(tabId)) live.push(tabId);
    if (live.length > 0) {
      try {
        const groupId = await api.groupTabs(live);
        await mutateSession(sessionId, (session, tabs) => (session ? { tabs: { ...tabs, groupId } } : undefined));
        await api.nameGroup(groupId, journaled.session.title);
        grouped = true;
      } catch {
        // The tabs stay open, ungrouped; the report still says which opened.
      }
    }

    // 5. Opened, with the report queued in the same write.
    await mutateSession(sessionId, (session, tabs) => {
      if (!session || session.phase !== "opening" || session.attempt?.id !== attemptId) return undefined;
      const openedSession: LocalSession = { ...session, phase: "open", openedAt: now().toISOString() };
      const statusOf = (taskId: string) => {
        if (tabs.tabs[taskId] !== undefined) return "opened" as const;
        const item = openedSession.items.find((candidate) => candidate.taskId === taskId);
        if (item?.tab === "closed") return "closed" as const;
        return item?.urlProblem !== undefined ? ("skipped" as const) : ("failed" as const);
      };
      const report = hasFirstReport(openedSession)
        ? buildReport(
            openedSession,
            attempt.taskIds.map((taskId) => ({ taskId, status: statusOf(taskId) })),
          )
        : buildReport(openedSession, firstReportItems(openedSession, tabs));
      return { session: withQueuedEvent(openedSession, report) };
    });
    return { kind: "opened", opened, failed, grouped };
  });
  if (!locked.acquired) return { kind: "busy" };
  // 6. The report, outside the open lock (a slow runner mustn't hold it).
  if (locked.value.kind === "opened") await flushSession(sessionId, client);
  return locked.value;
}

/**
 * Marks every session whose journal says `opening` but whose open lock
 * nobody holds as `interrupted`: the context that was opening it stopped
 * (a closed side panel, a reload, a crash). The side panel then shows what
 * was recorded and lets the person choose. Run when the side panel opens
 * and when the worker starts.
 */
export async function recoverInterrupted(): Promise<string[]> {
  const recovered: string[] = [];
  for (const session of await listSessions()) {
    if (session.phase !== "opening") continue;
    if (!(await isLockFree(openLockName(session.sessionId)))) continue;
    const after = await mutateSession(session.sessionId, (current) => (current?.phase === "opening" ? { session: { ...current, phase: "interrupted" } } : undefined));
    if (after.session?.phase === "interrupted") recovered.push(session.sessionId);
  }
  return recovered;
}

/**
 * The person's other choice for an interrupted opening: keep what was
 * recorded and tell the runner. The items with no recorded tab are
 * reported `skipped` (the runner flags them for review); their tabs, if
 * any opened in the gap, are the person's to close.
 */
export async function settleInterrupted(sessionId: string, client: BridgeClient): Promise<boolean> {
  const settled = await withLockIfFree(openLockName(sessionId), async () => {
    const after = await mutateSession(sessionId, (session, tabs) => {
      if (!session || session.phase !== "interrupted") return undefined;
      const items = session.items.map((item) => (tabs.tabs[item.taskId] === undefined && item.tab === "opened" ? { ...item, tab: "skipped" as const } : item));
      const openedSession: LocalSession = { ...session, items, phase: "open", openedAt: session.openedAt ?? new Date().toISOString() };
      const attemptIds = session.attempt?.taskIds ?? [];
      const report = hasFirstReport(openedSession)
        ? buildReport(
            openedSession,
            attemptIds.map((taskId) => ({ taskId, status: tabs.tabs[taskId] !== undefined ? ("opened" as const) : ("skipped" as const) })),
          )
        : buildReport(openedSession, firstReportItems(openedSession, tabs));
      return { session: withQueuedEvent(openedSession, report) };
    });
    return after.session?.phase === "open";
  });
  if (!settled.acquired || !settled.value) return false;
  await flushSession(sessionId, client);
  return true;
}
