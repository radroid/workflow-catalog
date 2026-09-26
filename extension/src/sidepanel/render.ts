/**
 * The side panel's markup (P07 part C, mvp-spec F9 and §6: "side panel
 * (current task: documents, remaining steps, Applied/Deferred)"). Plain
 * functions from a view to DOM, so the unit tests and the screenshots see
 * exactly what the panel shows. Every string -- a session title, an
 * address -- is set as text (shared/dom.ts), never as markup: a title or
 * URL is data, never instructions.
 *
 * The panel knows each application by its task ID and its stored job
 * address only (the session manifest carries nothing else), so a task is
 * named by its address. Its prepared documents live in the runner, which
 * the panel links to; the extension can reach only the bridge's four
 * routes, never the runner's local UI API.
 */
import { el } from "../shared/dom";
import { formatTimestamp } from "../shared/format";
import { FLASH_CLASS, type Tone } from "../shared/tone";
import { describeCommandRefusal, describeUrlProblem } from "../session/policy";
import type { ChoiceProblem, LocalSession, SessionItem, TabMap } from "../session/store";

export const RUNNER_UI = "http://127.0.0.1:4310/ui";
export const RUNNER_APPLICATIONS_URL = `${RUNNER_UI}/application`;
export const RUNNER_BOARD_URL = `${RUNNER_UI}/board`;

/** How many sessions the list shows, newest first. */
export const MAX_SESSIONS_SHOWN = 10;

export type ConnectionView =
  | { readonly kind: "checking" }
  | { readonly kind: "connected"; readonly at: string }
  | { readonly kind: "not_paired" }
  /** Paired since the last check (in Settings); nothing asked the runner yet. */
  | { readonly kind: "unchecked" }
  | { readonly kind: "problem"; readonly message: string };

export interface Line {
  readonly tone: Tone;
  readonly text: string;
  /** A follow-up action offered with the line. */
  readonly action?: "refresh" | "retry" | "board";
}

export interface PanelView {
  readonly connection: ConnectionView;
  readonly sessions: readonly LocalSession[];
  readonly tabMaps: ReadonlyMap<string, TabMap>;
  readonly current?: { readonly sessionId: string; readonly taskId: string };
  /** Outcome lines, keyed `task:<taskId>` or `session:<sessionId>`. Not live: the panel's one live region says them. */
  readonly lines: ReadonlyMap<string, Line>;
  /** Sessions showing the same-title warning before a reopen. */
  readonly confirmReopen: ReadonlyMap<string, number>;
  /** Actions in flight, by focus key. */
  readonly busy: ReadonlySet<string>;
}

export interface PanelHandlers {
  checkNow(): void;
  openSettings(): void;
  start(sessionId: string): void;
  resume(sessionId: string): void;
  settle(sessionId: string): void;
  reopen(sessionId: string, confirmed: boolean): void;
  cancelReopen(sessionId: string): void;
  show(sessionId: string, taskId: string): void;
  goToTab(tabId: number): void;
  choose(sessionId: string, taskId: string, status: "applied" | "deferred"): void;
  refresh(sessionId: string, taskId: string): void;
}

/** Splits text on backtick pairs into text and `<code>` (the bridge writes commands that way). */
export function withInlineCode(text: string): Array<string | HTMLElement> {
  return text.split("`").map((part, index) => (index % 2 === 1 ? el("code", { text: part }) : part)).filter((part) => part !== "");
}

/** A task's address as a person reads it: the host, and the rest. */
export function describeAddress(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    return { host: parsed.hostname.replace(/^www\./, ""), path };
  } catch {
    return { host: url, path: "" };
  }
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  saved: "Saved",
  preparing: "Preparing",
  ready: "Ready",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

function stageLabel(stage: string | undefined): string {
  if (!stage) return "Not heard from the runner yet";
  return STAGE_LABELS[stage] ?? stage;
}

function button(label: string, focusKey: string, onClick: () => void, options: { primary?: boolean; ghost?: boolean; busy?: boolean; busyLabel?: string } = {}): HTMLButtonElement {
  const node = el("button", {
    className: options.primary ? "primary" : options.ghost ? "ghost" : "",
    attrs: { type: "button", "data-focus": focusKey },
    text: options.busy ? (options.busyLabel ?? label) : label,
  });
  if (options.busy) node.setAttribute("aria-disabled", "true");
  node.addEventListener("click", () => {
    if (node.getAttribute("aria-disabled") === "true") return;
    onClick();
  });
  return node;
}

function lineNode(line: Line | undefined, extra: Array<Node | string> = []): HTMLElement | null {
  if (!line) return null;
  return el("p", { className: FLASH_CLASS[line.tone], attrs: { "data-line": "" } }, [...withInlineCode(line.text), ...extra]);
}

function connectionSection(view: PanelView, handlers: PanelHandlers): HTMLElement {
  const connection = view.connection;
  const children: Array<Node | string> = [];
  if (connection.kind === "checking") children.push(el("p", { className: "small", text: "Checking the runner for sessions…" }));
  if (connection.kind === "connected") children.push(el("p", { className: "small", text: `Connected to the runner. Checked ${formatTimestamp(connection.at)}.` }));
  if (connection.kind === "not_paired") {
    children.push(el("p", { className: FLASH_CLASS.act, text: "Pair this browser in Settings to receive sessions from the runner." }));
  }
  if (connection.kind === "unchecked") children.push(el("p", { className: "small", text: "Paired. Check for sessions to see what the runner sent." }));
  if (connection.kind === "problem") children.push(el("p", { className: FLASH_CLASS.act, attrs: { "data-connection-problem": "" } }, withInlineCode(connection.message)));
  const actions = el("div", { className: "row" }, [
    button("Check for sessions", "check", handlers.checkNow, { ghost: true, busy: view.busy.has("check"), busyLabel: "Checking…" }),
  ]);
  if (connection.kind === "not_paired" || (connection.kind === "problem" && /pair/i.test(connection.message))) {
    actions.append(button("Open Settings", "settings", handlers.openSettings, { ghost: true }));
  }
  const section = el("section", { attrs: { "aria-labelledby": "connection-heading" } }, [
    el("h2", { attrs: { id: "connection-heading" }, text: "Runner" }),
    el("div", { className: "stack" }, [...children, actions]),
  ]);
  section.dataset.section = "connection";
  return section;
}

function itemIndex(session: LocalSession, taskId: string): number {
  return session.items.findIndex((item) => item.taskId === taskId);
}

function tabIdOf(view: PanelView, sessionId: string, taskId: string): number | undefined {
  return view.tabMaps.get(sessionId)?.tabs[taskId];
}

function tabLabel(view: PanelView, session: LocalSession, item: SessionItem): string {
  if (item.urlProblem) return "Not opened";
  if (tabIdOf(view, session.sessionId, item.taskId) !== undefined) return "Open";
  if (item.tab === "closed") return "Closed";
  if (item.tab === "failed") return "Couldn't open";
  if (session.phase === "waiting" || session.phase === "refused") return "Not opened yet";
  return "Not open";
}

function choiceLabel(item: SessionItem): string {
  if (!item.choice) return "To do";
  if (item.choice.status === "applied") return item.choice.outcome === "local" ? "Applied (here only)" : "Applied";
  return item.choice.outcome === "local" ? "Deferred (here only)" : "Deferred";
}

function choicePill(item: SessionItem): HTMLElement {
  const decided = item.choice !== undefined;
  const className = !decided ? "pill" : item.choice?.status === "applied" ? "pill ok" : "pill";
  return el("span", { className, text: choiceLabel(item) });
}

/** What the line under a task says for a choice problem. */
export function choiceProblemLine(problem: ChoiceProblem): Line {
  switch (problem) {
    case "stale_revision":
      return { tone: "act", text: "This application changed on the runner since this browser last heard, so nothing changed. Refresh it, then choose again.", action: "refresh" };
    case "stage_moved_on":
      return { tone: "act", text: "It has already moved past Applied on the runner's Board, so nothing changed.", action: "board" };
    case "not_for_device":
      return { tone: "act", text: "The runner didn't send this application to this browser's pairing, so it can't be marked from here. Mark it on the runner's Board.", action: "board" };
    case "pairing":
      return { tone: "act", text: "Your choice wasn't sent: this browser isn't paired. Pair it again in Settings, then choose again." };
    case "unreachable":
      return { tone: "info", text: "Can't reach the runner, so your choice isn't recorded yet. It's sent once the runner answers.", action: "retry" };
    case "refused":
      return { tone: "act", text: "The runner didn't take that choice, so nothing changed. Mark it on the runner's Board.", action: "board" };
  }
}

function boardLink(): HTMLElement {
  return el("a", { attrs: { href: RUNNER_BOARD_URL, target: "_blank", rel: "noopener" }, text: "Open the runner's Board" });
}

function stepsList(view: PanelView, session: LocalSession, item: SessionItem): HTMLElement {
  const opened = item.tab === "opened" || item.tab === "closed" || tabIdOf(view, session.sessionId, item.taskId) !== undefined;
  const steps: Array<[string, boolean | undefined]> = [
    ["Open the posting in its tab", opened],
    ["Check your prepared documents in the runner", undefined],
    ["Fill in and submit the application on the employer's site yourself", undefined],
    ["Mark it Applied here, or Defer it", item.choice !== undefined],
  ];
  return el(
    "ol",
    { className: "steps" },
    steps.map(([text, done]) => el("li", done ? { attrs: { "data-done": "" } } : {}, [text, ...(done ? [el("span", { className: "done", text: " — done" })] : [])])),
  );
}

function currentSection(view: PanelView, handlers: PanelHandlers): HTMLElement | null {
  if (!view.current) return null;
  const session = view.sessions.find((candidate) => candidate.sessionId === view.current?.sessionId);
  const item = session?.items.find((candidate) => candidate.taskId === view.current?.taskId);
  if (!session || !item) return null;
  const { host, path } = describeAddress(item.url);
  const index = itemIndex(session, item.taskId);
  const tabId = tabIdOf(view, session.sessionId, item.taskId);
  const line = view.lines.get(`task:${item.taskId}`) ?? (item.choiceProblem ? choiceProblemLine(item.choiceProblem) : undefined);

  const facts = el("dl", { className: "kv" }, [
    el("dt", { text: "Stage" }),
    el("dd", { text: session.source === "file" ? "Kept by the runner (this session came from a file)" : stageLabel(item.stage) }),
    el("dt", { text: "Tab" }),
    el("dd", { text: tabLabel(view, session, item) }),
    el("dt", { text: "Your choice" }),
    el("dd", {}, [choicePill(item)]),
  ]);

  const documents = el("div", { className: "stack tight" }, [
    el("h3", { text: "Prepared documents" }),
    el("p", { className: "small", text: "Your resume and cover letter for this application are in the runner, with what changed and why." }),
    el("a", { attrs: { href: RUNNER_APPLICATIONS_URL, target: "_blank", rel: "noopener", "data-focus": `docs:${item.taskId}` }, text: "Open them on the runner's Applications page" }),
  ]);

  const actions = el("div", { className: "row wrap" });
  const applied = item.choice?.status === "applied";
  if (!applied && !item.urlProblem) {
    actions.append(
      button("Applied", `applied:${item.taskId}`, () => handlers.choose(session.sessionId, item.taskId, "applied"), {
        primary: true,
        busy: view.busy.has(`applied:${item.taskId}`),
        busyLabel: "Sending…",
      }),
    );
    if (item.choice?.status !== "deferred") {
      actions.append(
        button("Defer", `deferred:${item.taskId}`, () => handlers.choose(session.sessionId, item.taskId, "deferred"), {
          busy: view.busy.has(`deferred:${item.taskId}`),
          busyLabel: "Sending…",
        }),
      );
    }
  }
  if (tabId !== undefined) actions.append(button("Go to its tab", `goto:${item.taskId}`, () => handlers.goToTab(tabId), { ghost: true }));

  const lineExtras: Array<Node | string> = [];
  if (line?.action === "refresh") {
    lineExtras.push(" ", button("Refresh", `refresh:${item.taskId}`, () => handlers.refresh(session.sessionId, item.taskId), { ghost: true, busy: view.busy.has(`refresh:${item.taskId}`), busyLabel: "Refreshing…" }));
  }
  if (line?.action === "retry") {
    const status = pendingStatus(session, item.taskId);
    if (status) lineExtras.push(" ", button("Try again", `retry:${item.taskId}`, () => handlers.choose(session.sessionId, item.taskId, status), { ghost: true }));
  }
  if (line?.action === "board") lineExtras.push(" ", boardLink());

  const section = el("section", { attrs: { "aria-labelledby": "current-heading" } }, [
    el("h2", { attrs: { id: "current-heading" }, text: "Current application" }),
    el("div", { className: "card pad stack", attrs: { "data-task": item.taskId } }, [
      el("div", { className: "eyebrow", text: `${index + 1} of ${session.items.length} · ${session.title}` }),
      el("h3", { className: "title", attrs: { id: `task-heading-${item.taskId}`, tabindex: "-1", "data-focus": `task:${item.taskId}` }, text: host }),
      ...(path ? [el("p", { className: "url", text: path })] : []),
      facts,
      documents,
      el("div", { className: "stack tight" }, [el("h3", { text: "Remaining steps" }), stepsList(view, session, item)]),
      ...(item.urlProblem ? [el("p", { className: FLASH_CLASS.act, text: describeUrlProblem(item.urlProblem) })] : []),
      ...(actions.childElementCount > 0 ? [actions] : []),
      ...(line ? [lineNode(line, lineExtras)!] : []),
    ]),
  ]);
  section.dataset.section = "current";
  return section;
}

function pendingStatus(session: LocalSession, taskId: string): "applied" | "deferred" | undefined {
  for (const entry of [...session.events].reverse()) {
    if (entry.event.type === "application_status_changed" && entry.event.taskId === taskId && entry.state === "pending") return entry.event.status;
  }
  return undefined;
}

function sessionStateLine(view: PanelView, session: LocalSession): Line | undefined {
  const own = view.lines.get(`session:${session.sessionId}`);
  if (own) return own;
  if (session.phase === "refused" && session.refusal) return { tone: "act", text: describeCommandRefusal(session.refusal) };
  if (session.reportProblem === "expired") {
    return { tone: "act", text: "The runner didn't hear about this session before it expired, so it can't record choices from here. Mark your applications on the runner's Board.", action: "board" };
  }
  if (session.reportProblem) return { tone: "act", text: "The runner won't take updates on this session from this browser. Mark your applications on the runner's Board.", action: "board" };
  const pending = session.events.filter((entry) => entry.state === "pending").length;
  if (pending > 0) return { tone: "info", text: `${pending} update${pending === 1 ? "" : "s"} waiting to reach the runner; sent once it answers.` };
  return undefined;
}

function itemRow(view: PanelView, session: LocalSession, item: SessionItem, handlers: PanelHandlers): HTMLElement {
  const { host, path } = describeAddress(item.url);
  const current = view.current?.sessionId === session.sessionId && view.current.taskId === item.taskId;
  const row = el("li", { className: `task-row${current ? " current" : ""}` }, [
    el("div", { className: "task-main" }, [el("div", { className: "task-host", text: host }), ...(path ? [el("div", { className: "url", text: path })] : [])]),
    el("div", { className: "task-state" }, [el("span", { className: "small", text: tabLabel(view, session, item) }), choicePill(item)]),
  ]);
  if (item.urlProblem) row.append(el("p", { className: "small task-note", text: describeUrlProblem(item.urlProblem) }));
  if (session.phase === "open" && !current) {
    row.append(button("Show", `show:${item.taskId}`, () => handlers.show(session.sessionId, item.taskId), { ghost: true }));
  }
  if (current) row.setAttribute("aria-current", "true");
  return row;
}

function sessionCard(view: PanelView, session: LocalSession, handlers: PanelHandlers): HTMLElement {
  const tabs = view.tabMaps.get(session.sessionId)?.tabs ?? {};
  const tracked = session.items.filter((item) => tabs[item.taskId] !== undefined).length;
  const openable = session.items.filter((item) => item.urlProblem === undefined).length;
  const count = `${session.items.length} application${session.items.length === 1 ? "" : "s"}`;
  const from = session.source === "file" ? " · from a file" : "";
  let status: string;
  const actions = el("div", { className: "row wrap" });
  const extra: HTMLElement[] = [];

  switch (session.phase) {
    case "waiting":
      status = `Ready to open in your browser · ${count}${from}`;
      actions.append(button("Start applying", `start:${session.sessionId}`, () => handlers.start(session.sessionId), { primary: true, busy: view.busy.has(`start:${session.sessionId}`), busyLabel: "Opening…" }));
      if (openable < session.items.length) extra.push(el("p", { className: "small", text: `${session.items.length - openable} of them won't be opened; see below.` }));
      break;
    case "opening":
      status = `Opening… · ${count}${from}`;
      break;
    case "interrupted": {
      const missing = session.items.filter((item) => item.urlProblem === undefined && tabs[item.taskId] === undefined).length;
      status = `Opening stopped partway · ${count}${from}`;
      extra.push(
        el("p", {
          className: FLASH_CLASS.act,
          attrs: { "data-interrupted": "" },
          text: `Opening this session stopped before it finished. ${tracked} of ${openable} tab${openable === 1 ? " was" : "s were"} recorded. A tab for the others may already be open; this extension can't tell, and won't adopt it. Close any duplicate yourself.`,
        }),
      );
      if (missing > 0) {
        actions.append(button(`Open the ${missing} missing tab${missing === 1 ? "" : "s"}`, `resume:${session.sessionId}`, () => handlers.resume(session.sessionId), { primary: true, busy: view.busy.has(`resume:${session.sessionId}`), busyLabel: "Opening…" }));
      }
      actions.append(button("Keep what opened", `settle:${session.sessionId}`, () => handlers.settle(session.sessionId), { busy: view.busy.has(`settle:${session.sessionId}`), busyLabel: "Saving…" }));
      break;
    }
    case "open": {
      const decided = session.items.filter((item) => item.choice !== undefined).length;
      status = `Opened${session.openedAt ? ` ${formatTimestamp(session.openedAt)}` : ""} · ${decided} of ${session.items.length} marked${from}`;
      const warning = view.confirmReopen.get(session.sessionId);
      if (warning !== undefined) {
        extra.push(
          el("p", {
            className: FLASH_CLASS.act,
            attrs: { "data-same-title": "" },
            text: `A tab group named “${session.title}” is already open${warning > 1 ? ` (${warning} of them)` : ""}, maybe restored by Chrome. This extension won't use its tabs: reopening makes a new group.`,
          }),
        );
        actions.append(
          button("Open a new group anyway", `reopen-confirm:${session.sessionId}`, () => handlers.reopen(session.sessionId, true), { primary: true, busy: view.busy.has(`reopen-confirm:${session.sessionId}`), busyLabel: "Opening…" }),
          button("Cancel", `reopen-cancel:${session.sessionId}`, () => handlers.cancelReopen(session.sessionId), { ghost: true }),
        );
      } else if (tracked === 0 && openable > 0) {
        extra.push(el("p", { className: "small", text: "None of its tabs are open in this browser session. Reopen it to get them back; tabs Chrome restored by itself aren't adopted." }));
        actions.append(button("Reopen session", `reopen:${session.sessionId}`, () => handlers.reopen(session.sessionId, false), { busy: view.busy.has(`reopen:${session.sessionId}`), busyLabel: "Opening…" }));
      }
      break;
    }
    case "refused":
      status = `Not opened · ${count}${from}`;
      break;
  }

  const line = sessionStateLine(view, session);
  const list = el(
    "ul",
    { className: "task-list" },
    session.items.map((item) => itemRow(view, session, item, handlers)),
  );
  const card = el("article", { className: "card pad stack", attrs: { "data-session": session.sessionId, "aria-labelledby": `session-title-${session.sessionId}` } }, [
    el("div", { className: "stack tight" }, [
      el("h3", { className: "title", attrs: { id: `session-title-${session.sessionId}` }, text: session.title }),
      el("p", { className: "small", attrs: { "data-session-status": "" }, text: status }),
    ]),
    ...extra,
    ...(line ? [lineNode(line, line.action === "board" ? [" ", boardLink()] : [])!] : []),
    list,
    ...(actions.childElementCount > 0 ? [actions] : []),
  ]);
  return card;
}

function sessionsSection(view: PanelView, handlers: PanelHandlers): HTMLElement {
  const shown = view.sessions.slice(0, MAX_SESSIONS_SHOWN);
  const body: Array<Node | string> =
    shown.length === 0
      ? [
          el("p", {
            className: "small",
            text: "No sessions yet. Choose Ready applications on the runner's Board and start a session; it appears here, ready to open. Nothing opens until you choose Start applying.",
          }),
        ]
      : shown.map((session) => sessionCard(view, session, handlers));
  if (view.sessions.length > shown.length) body.push(el("p", { className: "small", text: `${view.sessions.length - shown.length} older sessions aren't shown.` }));
  const section = el("section", { attrs: { "aria-labelledby": "sessions-heading" } }, [el("h2", { attrs: { id: "sessions-heading" }, text: "Sessions" }), el("div", { className: "stack" }, body)]);
  section.dataset.section = "sessions";
  return section;
}

/** The whole panel, below its persistent live region. */
export function renderPanel(view: PanelView, handlers: PanelHandlers): HTMLElement {
  const current = currentSection(view, handlers);
  return el("div", { className: "stack roomy" }, [
    el("header", { className: "stack tight" }, [el("div", { className: "eyebrow", text: "Job Assistant" }), el("h1", { text: "Applications" })]),
    connectionSection(view, handlers),
    ...(current ? [current] : []),
    sessionsSection(view, handlers),
  ]);
}
