import { describe, expect, it, vi } from "vitest";
import type { LocalSession, SessionItem, TabMap } from "../session/store";
import { choiceProblemLine, renderPanel, RUNNER_APPLICATIONS_URL, type PanelHandlers, type PanelView } from "./render";

const SESSION_ID = "5b6f1c2e-8d4a-4f3b-9c1d-2e3f4a5b6c7d";
const TASKS = ["7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", "2e4f6a8b-0c1d-4e3f-9a5b-7c9d1e3f5a7b", "4a6c8e0a-2b3c-4d5e-8f6a-7b8c9d0e1f2a"];

function item(index: number, extra: Partial<SessionItem> = {}): SessionItem {
  return { taskId: TASKS[index]!, jobRevision: 1, url: `https://jobs.example/postings/fictional-${index + 1}`, revision: 1, stage: "ready", ...extra };
}

function session(extra: Partial<LocalSession> = {}): LocalSession {
  return {
    sessionId: SESSION_ID,
    title: "Apply today",
    source: "bridge",
    commandId: "0d2e8b20-4b3c-4e77-9f50-2c3d4e5f6071",
    receivedAt: "2026-09-25T09:00:00.000Z",
    phase: "open",
    openedAt: "2026-09-25T09:01:00.000Z",
    items: [item(0, { tab: "opened" }), item(1, { tab: "opened" }), item(2, { tab: "opened" })],
    events: [],
    ...extra,
  };
}

function view(extra: Partial<PanelView> = {}, tabs: TabMap = { tabs: { [TASKS[0]!]: 100, [TASKS[1]!]: 101, [TASKS[2]!]: 102 }, groupId: 7 }): PanelView {
  return {
    connection: { kind: "connected", at: "2026-09-25T09:02:00.000Z" },
    sessions: [session()],
    tabMaps: new Map([[SESSION_ID, tabs]]),
    current: { sessionId: SESSION_ID, taskId: TASKS[0]! },
    lines: new Map(),
    confirmReopen: new Map(),
    busy: new Set(),
    ...extra,
  };
}

function handlers() {
  return {
    checkNow: vi.fn<PanelHandlers["checkNow"]>(),
    openSettings: vi.fn<PanelHandlers["openSettings"]>(),
    start: vi.fn<PanelHandlers["start"]>(),
    resume: vi.fn<PanelHandlers["resume"]>(),
    settle: vi.fn<PanelHandlers["settle"]>(),
    reopen: vi.fn<PanelHandlers["reopen"]>(),
    cancelReopen: vi.fn<PanelHandlers["cancelReopen"]>(),
    show: vi.fn<PanelHandlers["show"]>(),
    goToTab: vi.fn<PanelHandlers["goToTab"]>(),
    choose: vi.fn<PanelHandlers["choose"]>(),
    refresh: vi.fn<PanelHandlers["refresh"]>(),
  } satisfies PanelHandlers;
}

function buttonNamed(root: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((node) => node.textContent === name);
}

function current(root: HTMLElement): HTMLElement {
  return root.querySelector('[data-section="current"]') as HTMLElement;
}

describe("the side panel's current application: the job, its prepared documents, the remaining steps, Applied and Defer", () => {
  it("shows the job by its address, links the prepared documents to the runner, lists the steps, and offers Applied and Defer", () => {
    const on = handlers();
    const root = renderPanel(view(), on);
    const card = current(root);
    expect(card.querySelector("h3.title")?.textContent).toBe("jobs.example");
    expect(card.querySelector(".url")?.textContent).toBe("/postings/fictional-1");
    expect(card.querySelector(".eyebrow")?.textContent).toBe("1 of 3 · Apply today");
    const docs = card.querySelector(`a[href="${RUNNER_APPLICATIONS_URL}"]`);
    expect(docs?.textContent).toBe("Open them on the runner's Applications page");
    expect(docs?.getAttribute("target")).toBe("_blank");
    expect(docs?.getAttribute("rel")).toBe("noopener");
    expect([...card.querySelectorAll(".steps li")].map((li) => li.hasAttribute("data-done"))).toEqual([true, false, false, false]);
    expect(card.textContent).toContain("Stage");
    expect(card.textContent).toContain("Ready");

    buttonNamed(card, "Applied")!.click();
    expect(on.choose).toHaveBeenCalledWith(SESSION_ID, TASKS[0], "applied");
    buttonNamed(card, "Defer")!.click();
    expect(on.choose).toHaveBeenCalledWith(SESSION_ID, TASKS[0], "deferred");
    buttonNamed(card, "Go to its tab")!.click();
    expect(on.goToTab).toHaveBeenCalledWith(100);
  });

  it("after Applied: the choice shows, the last step is done, and there is nothing left to press", () => {
    const applied = session({ items: [item(0, { tab: "opened", stage: "applied", revision: 2, choice: { status: "applied", at: "2026-09-25T09:10:00.000Z", outcome: "applied" } }), item(1), item(2)] });
    const card = current(renderPanel(view({ sessions: [applied] }), handlers()));
    expect(card.querySelector(".pill")?.textContent).toBe("Applied");
    expect(card.textContent).toContain("Applied");
    expect(buttonNamed(card, "Applied")).toBeUndefined();
    expect(buttonNamed(card, "Defer")).toBeUndefined();
    expect(card.querySelectorAll(".steps li")[3]?.hasAttribute("data-done")).toBe(true);
  });

  it("after Defer: Deferred shows, the stage stays Ready, and Applied is still there", () => {
    const deferred = session({ items: [item(0, { tab: "opened", choice: { status: "deferred", at: "2026-09-25T09:10:00.000Z", outcome: "deferred" } }), item(1), item(2)] });
    const card = current(renderPanel(view({ sessions: [deferred] }), handlers()));
    expect(card.querySelector(".pill")?.textContent).toBe("Deferred");
    expect(card.querySelector("dl")?.textContent).toContain("Ready");
    expect(buttonNamed(card, "Applied")).toBeDefined();
    expect(buttonNamed(card, "Defer")).toBeUndefined();
  });

  it("a stale refusal says so plainly and offers Refresh, never a blind retry", () => {
    const on = handlers();
    const stale = session({ items: [item(0, { tab: "opened", choiceProblem: "stale_revision" }), item(1), item(2)] });
    const card = current(renderPanel(view({ sessions: [stale] }), on));
    expect(card.querySelector("[data-line]")?.textContent).toContain(choiceProblemLine("stale_revision").text);
    expect(buttonNamed(card, "Try again")).toBeUndefined();
    buttonNamed(card, "Refresh")!.click();
    expect(on.refresh).toHaveBeenCalledWith(SESSION_ID, TASKS[0]);
  });

  it("a choice from a session imported from a file says it is kept here only", () => {
    const local = session({ source: "file", commandId: undefined, items: [item(0, { tab: "opened", revision: undefined, stage: undefined, choice: { status: "applied", at: "2026-09-25T09:10:00.000Z", outcome: "local" } }), item(1), item(2)] });
    const card = current(renderPanel(view({ sessions: [local] }), handlers()));
    expect(card.querySelector(".pill")?.textContent).toBe("Applied (here only)");
    expect(card.querySelector("dl")?.textContent).toContain("Kept by the runner (this session came from a file)");
  });

  it("a busy button stays focusable (aria-disabled) and ignores a second press", () => {
    const on = handlers();
    const card = current(renderPanel(view({ busy: new Set([`applied:${TASKS[0]}`]) }), on));
    const sending = buttonNamed(card, "Sending…")!;
    expect(sending.getAttribute("aria-disabled")).toBe("true");
    expect(sending.disabled).toBe(false);
    sending.click();
    expect(on.choose).not.toHaveBeenCalled();
  });
});

describe("the side panel's sessions: waiting, interrupted, reopen", () => {
  it("a waiting session says it is ready to open, and only Start applying opens it", () => {
    const on = handlers();
    const waiting = session({ phase: "waiting", openedAt: undefined, items: [item(0), item(1), item(2, { urlProblem: "private_host" })] });
    const root = renderPanel(view({ sessions: [waiting], current: undefined }, { tabs: {} }), on);
    const card = root.querySelector(`[data-session="${SESSION_ID}"]`) as HTMLElement;
    expect(card.querySelector("[data-session-status]")?.textContent).toBe("Ready to open in your browser · 3 applications");
    expect(card.textContent).toContain("1 of them won't be opened; see below.");
    expect(card.textContent).toContain("Its address points at this computer or a private network, so it won't be opened.");
    buttonNamed(card, "Start applying")!.click();
    expect(on.start).toHaveBeenCalledWith(SESSION_ID);
    expect(root.querySelector('[data-section="current"]')).toBeNull();
  });

  it("an interrupted opening says what was recorded, warns a duplicate may be open, and asks: open the missing tabs, or keep what opened", () => {
    const on = handlers();
    const interrupted = session({ phase: "interrupted", items: [item(0, { tab: "opened" }), item(1), item(2)] });
    const root = renderPanel(view({ sessions: [interrupted], current: undefined }, { tabs: { [TASKS[0]!]: 100 } }), on);
    const card = root.querySelector(`[data-session="${SESSION_ID}"]`) as HTMLElement;
    expect(card.querySelector("[data-interrupted]")?.textContent).toBe(
      "Opening this session stopped before it finished. 1 of 3 tabs were recorded. A tab for the others may already be open; this extension can't tell, and won't adopt it. Close any duplicate yourself.",
    );
    expect(card.querySelector("[data-interrupted]")?.className).toBe("flash");
    buttonNamed(card, "Open the 2 missing tabs")!.click();
    expect(on.resume).toHaveBeenCalledWith(SESSION_ID);
    buttonNamed(card, "Keep what opened")!.click();
    expect(on.settle).toHaveBeenCalledWith(SESSION_ID);
  });

  it("an opened session with none of its tabs in this browser session offers Reopen session", () => {
    const on = handlers();
    const root = renderPanel(view({ current: undefined }, { tabs: {} }), on);
    const card = root.querySelector(`[data-session="${SESSION_ID}"]`) as HTMLElement;
    expect(card.textContent).toContain("None of its tabs are open in this browser session. Reopen it to get them back; tabs Chrome restored by itself aren't adopted.");
    buttonNamed(card, "Reopen session")!.click();
    expect(on.reopen).toHaveBeenCalledWith(SESSION_ID, false);
  });

  it("Reopen with a group of the same title open warns, and opens a new group only when asked again", () => {
    const on = handlers();
    const root = renderPanel(view({ current: undefined, confirmReopen: new Map([[SESSION_ID, 1]]) }, { tabs: {} }), on);
    const card = root.querySelector(`[data-session="${SESSION_ID}"]`) as HTMLElement;
    expect(card.querySelector("[data-same-title]")?.textContent).toBe(
      "A tab group named “Apply today” is already open, maybe restored by Chrome. This extension won't use its tabs: reopening makes a new group.",
    );
    expect(buttonNamed(card, "Reopen session")).toBeUndefined();
    buttonNamed(card, "Open a new group anyway")!.click();
    expect(on.reopen).toHaveBeenCalledWith(SESSION_ID, true);
    buttonNamed(card, "Cancel")!.click();
    expect(on.cancelReopen).toHaveBeenCalledWith(SESSION_ID);
  });

  it("a refused command says why, with no way to open it", () => {
    const refused = session({ phase: "refused", refusal: "other_device", openedAt: undefined, items: [item(0), item(1), item(2)] });
    const root = renderPanel(view({ sessions: [refused], current: undefined }, { tabs: {} }), handlers());
    const card = root.querySelector(`[data-session="${SESSION_ID}"]`) as HTMLElement;
    expect(card.textContent).toContain("It was meant for another browser, so it wasn't opened here.");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("a session title and an address are data: shown as text, never as markup", () => {
    const hostile = session({ title: '<img src=x onerror="alert(1)">Apply', items: [item(0, { url: "https://jobs.example/<script>alert(1)</script>" }), item(1), item(2)] });
    const root = renderPanel(view({ sessions: [hostile] }), handlers());
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">Apply');
  });

  it("with no sessions it says how to start one, and that nothing opens until Start applying", () => {
    const root = renderPanel(view({ sessions: [], current: undefined }), handlers());
    expect(root.querySelector('[data-section="sessions"]')?.textContent).toContain("Nothing opens until you choose Start applying.");
    expect(root.querySelector("h1")?.textContent).toBe("Applications");
  });

  it("not paired: says to pair, and offers Settings", () => {
    const on = handlers();
    const root = renderPanel(view({ connection: { kind: "not_paired" }, sessions: [], current: undefined }), on);
    expect(root.textContent).toContain("Pair this browser in Settings to receive sessions from the runner.");
    buttonNamed(root, "Open Settings")!.click();
    expect(on.openSettings).toHaveBeenCalled();
  });
});
