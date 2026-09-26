/**
 * The side panel (P07 part C, mvp-spec F9): the sessions the runner sent,
 * "Ready to open in your browser" until the person chooses Start applying;
 * the current application, its prepared documents (in the runner),
 * remaining steps and the Applied / Defer buttons; and Reopen session.
 *
 * - Opening the panel polls `GET /commands` once (the worker's alarm does
 *   the rest). Polling only takes sessions in; tabs open only from a click
 *   here (session/open.ts).
 * - The current application is the one whose recorded tab is active in
 *   this window, or the one the person chose with Show, or the first one
 *   still to do.
 * - What the person's actions lead to is said once, by one live region
 *   that is never rebuilt; the rest of the panel is redrawn from storage,
 *   and focus stays on the control that had it (or moves to the task it
 *   was about).
 */
import "../shared/zod-jitless";
import { bridgeClient, FOREIGN_SERVER_MESSAGE, type BridgeError } from "../shared/bridge-client";
import { el, mount } from "../shared/dom";
import { applyColorScheme } from "../shared/theme-init";
import { openSession, recoverInterrupted, settleInterrupted, type OpenKind, type OpenOutcome } from "../session/open";
import { pollCommands, type PollOutcome } from "../session/receive";
import { chooseStatus, refreshRevisions, type ChoiceOutcome } from "../session/report";
import { isSessionStorageKey, listSessions, listTabMaps, readSession, type LocalSession, type TabMap } from "../session/store";
import { sessionTaskOfTab } from "../session/tabs";
import { choiceProblemLine, renderPanel, type ConnectionView, type Line, type PanelHandlers, type PanelView } from "./render";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("sidepanel/index.html is missing #app");
}

/** The one live region: says the outcome of what the person just did. Never rebuilt (a fresh region isn't announced). */
const live = el("p", { className: "sr-only", attrs: { role: "status", "aria-live": "polite", "data-live": "" } });
const body = el("div");
mount(app, el("main", { className: "panel" }, [live, body]));

interface MutableView {
  connection: ConnectionView;
  sessions: LocalSession[];
  tabMaps: Map<string, TabMap>;
  current?: { sessionId: string; taskId: string };
  lines: Map<string, Line>;
  confirmReopen: Map<string, number>;
  busy: Set<string>;
}

const view: MutableView = {
  connection: { kind: "checking" },
  sessions: [],
  tabMaps: new Map(),
  lines: new Map(),
  confirmReopen: new Map(),
  busy: new Set(),
};

/** The task the person chose with Show (or the last active one), kept while it exists. */
let selected: { sessionId: string; taskId: string } | undefined;
/** Where focus goes on the next draw, when the control that had it is gone. */
let nextFocus: string | undefined;

function announce(text: string): void {
  // The same sentence twice is still said twice: a changed text node is what a screen reader hears.
  live.textContent = live.textContent === text ? `${text}\u00a0` : text;
}

function exists(target: { sessionId: string; taskId: string } | undefined): boolean {
  if (!target) return false;
  const session = view.sessions.find((candidate) => candidate.sessionId === target.sessionId);
  return session?.items.some((item) => item.taskId === target.taskId) ?? false;
}

function defaultCurrent(): { sessionId: string; taskId: string } | undefined {
  const session = view.sessions.find((candidate) => candidate.phase === "open");
  if (!session) return undefined;
  const item = session.items.find((candidate) => candidate.choice === undefined && candidate.urlProblem === undefined) ?? session.items[0];
  return item ? { sessionId: session.sessionId, taskId: item.taskId } : undefined;
}

/** The active tab the panel last followed: switching to another tab selects its task; a redraw doesn't undo Show. */
let followedTabId: number | undefined;

/** The task of the active tab, when the person has just switched to it (undefined otherwise). */
async function newlyActiveTask(): Promise<{ sessionId: string; taskId: string } | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const recorded = await sessionTaskOfTab(tab?.id);
    const tabId = recorded ? tab?.id : undefined;
    if (tabId === followedTabId) return undefined;
    followedTabId = tabId;
    return recorded;
  } catch {
    return undefined;
  }
}

function draw(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  mount(body, renderPanel(view as PanelView, handlers));
  const wanted = [nextFocus, focused].filter((key): key is string => key !== undefined);
  nextFocus = undefined;
  for (const key of wanted) {
    const target = body.querySelector<HTMLElement>(`[data-focus="${key}"]`);
    if (target) {
      target.focus();
      return;
    }
  }
}

async function reload(): Promise<void> {
  view.sessions = await listSessions();
  view.tabMaps = await listTabMaps();
  const active = await newlyActiveTask();
  if (active) selected = active;
  view.current = exists(selected) ? selected : defaultCurrent();
  draw();
}

let reloadQueued = false;
function scheduleReload(): void {
  if (reloadQueued) return;
  reloadQueued = true;
  queueMicrotask(() => {
    reloadQueued = false;
    void reload();
  });
}

function connectionMessage(error: BridgeError): string {
  if (error.code === "network_error") return error.message;
  if (error.code === "invalid_response" || error.code === "unknown_error") return FOREIGN_SERVER_MESSAGE;
  if (error.code === "token_replaced") return "This browser was just paired again. Check again in a moment.";
  if (error.status === 401) return "Your pairing expired or was revoked. Pair again in Settings.";
  if (error.status === 403) return "This pairing belongs to a different install. Pair again in Settings.";
  if (error.status !== undefined && error.status >= 500) return "The runner had a problem. Check again in a moment, or restart it with `npm run runner`.";
  return error.message;
}

function connectionFor(outcome: PollOutcome): ConnectionView {
  if (outcome.kind === "not_paired") return { kind: "not_paired" };
  if (outcome.kind === "error") return { kind: "problem", message: connectionMessage(outcome.error) };
  return { kind: "connected", at: new Date().toISOString() };
}

function pollAnnouncement(outcome: PollOutcome): string {
  if (outcome.kind === "not_paired") return "Pair this browser in Settings to receive sessions from the runner.";
  if (outcome.kind === "error") return connectionMessage(outcome.error).replace(/`/g, "");
  if (outcome.received === 0) return "No new sessions.";
  return `${outcome.received} new session${outcome.received === 1 ? " is" : "s are"} ready to open.`;
}

async function poll(): Promise<PollOutcome> {
  const outcome = await pollCommands(bridgeClient);
  view.connection = connectionFor(outcome);
  return outcome;
}

async function busyWhile<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
  if (view.busy.has(key)) return undefined;
  view.busy.add(key);
  draw();
  try {
    return await work();
  } finally {
    view.busy.delete(key);
  }
}

function titleOf(sessionId: string): string {
  return view.sessions.find((session) => session.sessionId === sessionId)?.title ?? "this session";
}

function openLine(outcome: OpenOutcome, title: string): Line | undefined {
  switch (outcome.kind) {
    case "opened": {
      let text = `Opened “${title}”: ${outcome.opened} tab${outcome.opened === 1 ? "" : "s"}${outcome.grouped ? " in one group" : ""}.`;
      if (outcome.failed > 0) text += ` ${outcome.failed} couldn't be opened.`;
      if (!outcome.grouped && outcome.opened > 0) text += " They couldn't be grouped, so they're open on their own.";
      return { tone: outcome.failed > 0 ? "info" : "ok", text };
    }
    case "busy":
      return { tone: "info", text: "This session is already opening in another window." };
    case "not_now":
      return { tone: "info", text: "This session changed meanwhile; its state is below." };
    case "expired":
      return { tone: "act", text: "It expired before it was opened. Start a new session from the runner's Board.", action: "board" };
    case "nothing_to_open":
      return { tone: "act", text: "Nothing in this session can be opened." };
    case "gone":
      return { tone: "act", text: "This session isn't in this browser any more." };
    case "same_title":
      return undefined;
  }
}

async function runOpen(sessionId: string, kind: OpenKind, busyKey: string, confirmSameTitle = false): Promise<void> {
  const title = titleOf(sessionId);
  const outcome = await busyWhile(busyKey, () => openSession(sessionId, kind, bridgeClient, { confirmSameTitle }));
  if (!outcome) return;
  if (outcome.kind === "same_title") {
    view.confirmReopen.set(sessionId, outcome.groups);
    view.lines.delete(`session:${sessionId}`);
    nextFocus = `reopen-confirm:${sessionId}`;
    announce(`A tab group named “${title}” is already open, maybe restored by Chrome. Reopening makes a new group.`);
    await reload();
    return;
  }
  view.confirmReopen.delete(sessionId);
  const line = openLine(outcome, title);
  if (line) {
    view.lines.set(`session:${sessionId}`, line);
    announce(line.text);
  }
  if (outcome.kind === "opened") {
    const session = await readSession(sessionId);
    const first = session?.items.find((item) => item.urlProblem === undefined && item.choice === undefined);
    if (first) {
      selected = { sessionId, taskId: first.taskId };
      nextFocus = `task:${first.taskId}`;
    }
  }
  await reload();
}

function choiceLine(outcome: ChoiceOutcome, status: "applied" | "deferred"): Line {
  switch (outcome.kind) {
    case "recorded":
      if (outcome.outcome === "already_applied") return { tone: "ok", text: "It was already Applied on the runner's Board." };
      return status === "applied"
        ? { tone: "ok", text: "Marked Applied. The runner's Board shows it as Applied." }
        : { tone: "ok", text: "Deferred. Nothing moved on the runner's Board; you can still mark it Applied here." };
    case "local":
      return {
        tone: "act",
        text: `Recorded in this browser only. This session came from a file, so the runner can't be told from here: mark it ${status === "applied" ? "Applied" : "as deferred"} on the runner's Board too.`,
        action: "board",
      };
    case "no_revision":
      return { tone: "info", text: "Waiting for the runner to confirm this session before it can be marked. Check for sessions, then try again." };
    case "not_paired":
      return { tone: "act", text: "Pair this browser in Settings first; your choice wasn't sent." };
    case "other_pairing":
      return { tone: "act", text: "This session was sent to this browser's earlier pairing, so the runner won't take a choice from this one. Mark it on the runner's Board.", action: "board" };
    case "report_problem":
      return { tone: "act", text: "The runner won't take updates on this session from this browser. Mark it on the runner's Board.", action: "board" };
    case "problem":
      return choiceProblemLine(outcome.problem);
    case "gone":
      return { tone: "act", text: "This application isn't in this browser any more." };
  }
}

const handlers: PanelHandlers = {
  checkNow() {
    void (async () => {
      const outcome = await busyWhile("check", async () => {
        await recoverInterrupted();
        return poll();
      });
      if (!outcome) return;
      announce(pollAnnouncement(outcome));
      await reload();
    })();
  },
  openSettings() {
    void chrome.runtime.openOptionsPage();
  },
  start(sessionId) {
    void runOpen(sessionId, "open", `start:${sessionId}`);
  },
  resume(sessionId) {
    void runOpen(sessionId, "resume", `resume:${sessionId}`);
  },
  settle(sessionId) {
    void (async () => {
      const settled = await busyWhile(`settle:${sessionId}`, () => settleInterrupted(sessionId, bridgeClient));
      if (settled === undefined) return;
      const line: Line = settled
        ? { tone: "ok", text: "Kept what opened. The runner is told which tabs never opened, for you to review." }
        : { tone: "info", text: "This session changed meanwhile; its state is below." };
      view.lines.set(`session:${sessionId}`, line);
      announce(line.text);
      await reload();
    })();
  },
  reopen(sessionId, confirmed) {
    void runOpen(sessionId, "reopen", confirmed ? `reopen-confirm:${sessionId}` : `reopen:${sessionId}`, confirmed);
  },
  cancelReopen(sessionId) {
    view.confirmReopen.delete(sessionId);
    nextFocus = `reopen:${sessionId}`;
    announce("Not reopened.");
    draw();
  },
  show(sessionId, taskId) {
    selected = { sessionId, taskId };
    view.current = selected;
    nextFocus = `task:${taskId}`;
    draw();
  },
  goToTab(tabId) {
    void chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  },
  choose(sessionId, taskId, status) {
    void (async () => {
      const outcome = await busyWhile(`${status}:${taskId}`, () => chooseStatus(sessionId, taskId, status, bridgeClient));
      if (!outcome) return;
      const line = choiceLine(outcome, status);
      // A problem is kept on the item in storage (it changes when a later send gets through or is refused),
      // and the card draws its line from there; the other outcomes are this press's own.
      if (outcome.kind === "problem") view.lines.delete(`task:${taskId}`);
      else view.lines.set(`task:${taskId}`, line);
      nextFocus = `task:${taskId}`;
      announce(line.text);
      await reload();
    })();
  },
  refresh(sessionId, taskId) {
    void (async () => {
      const outcome = await busyWhile(`refresh:${taskId}`, () => refreshRevisions(sessionId, [taskId], bridgeClient));
      if (!outcome) return;
      const line: Line =
        outcome.kind === "refreshed"
          ? { tone: "info", text: "Refreshed from the runner. Choose again." }
          : outcome.kind === "waiting"
            ? { tone: "info", text: "Can't reach the runner to refresh. Try again once it's running." }
            : { tone: "act", text: "This browser can't refresh it. Mark it on the runner's Board.", action: "board" };
      view.lines.set(`task:${taskId}`, line);
      nextFocus = `task:${taskId}`;
      announce(line.text);
      await reload();
    })();
  },
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  const keys = Object.keys(changes);
  if (areaName === "session" && "deviceToken" in changes) {
    // Paired or un-paired elsewhere (Settings): say so, without a request of the panel's own. The next
    // check -- the button, or the worker's alarm -- asks the runner.
    const paired = changes.deviceToken?.newValue != null;
    if (!paired) view.connection = { kind: "not_paired" };
    else if (view.connection.kind === "not_paired" || view.connection.kind === "problem") view.connection = { kind: "unchecked" };
  }
  if (areaName === "local" && keys.some(isSessionStorageKey)) scheduleReload();
  if (areaName === "session" && keys.some((key) => isSessionStorageKey(key) || key === "deviceToken")) scheduleReload();
});

chrome.tabs.onActivated.addListener(() => {
  scheduleReload();
});

async function start(): Promise<void> {
  await recoverInterrupted();
  await reload();
  await poll();
  await reload();
}

void start();
