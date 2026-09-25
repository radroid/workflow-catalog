import "../shared/zod-jitless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { command, fakeBridge, installFakeChrome, pair, TASKS, type FakeBridge, type FakeChrome } from "./fake-chrome";

const SESSION_ID = command().sessionId;

let fake: FakeChrome;
let bridge: FakeBridge;

async function modules() {
  const open = await import("./open");
  const store = await import("./store");
  const receive = await import("./receive");
  const tabs = await import("./tabs");
  return { ...open, ...store, ...receive, ...tabs };
}

async function openedSession() {
  await pair();
  bridge.commands = [command()];
  const loaded = await modules();
  await loaded.pollCommands(bridge.client);
  await loaded.openSession(SESSION_ID, "open", bridge.client);
  return loaded;
}

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
  bridge = fakeBridge();
});

describe("gate 8: a closed tab reports only `closed`; a page never changes status", () => {
  it("closing a recorded tab sends one later report naming only that tab as closed, and no status event", async () => {
    const { readTabs, readSession, onSessionTabClosed } = await openedSession();
    const tabId = (await readTabs(SESSION_ID)).tabs[TASKS[1]]!;
    bridge.posted.length = 0;
    fake.closeTab(tabId);
    expect(await onSessionTabClosed(tabId, bridge.client)).toBe(true);
    expect(bridge.posted).toEqual([
      expect.objectContaining({ type: "browser_command_result", commandId: command().commandId, status: "completed", items: [{ taskId: TASKS[1], status: "closed" }] }),
    ]);
    expect(bridge.posted.some((event) => event.type === "application_status_changed")).toBe(false);
    const session = (await readSession(SESSION_ID))!;
    expect(session.items[1]).toMatchObject({ tab: "closed", stage: "ready" });
    expect(session.items[1]?.choice).toBeUndefined();
    expect((await readTabs(SESSION_ID)).tabs[TASKS[1]]).toBeUndefined();
  });

  it("the extension has no way to read a tab's page: nothing in the session code touches a tab's content", async () => {
    // What a "thank you for applying" page shows can't reach a status: the only status path is chooseStatus,
    // called from the side panel's Applied and Defer buttons (sidepanel/main.ts). The e2e drives a real page.
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [file, source] of Object.entries(sources)) {
      if (file.endsWith(".test.ts") || file.endsWith("fake-chrome.ts")) continue;
      expect(source, file).not.toMatch(/chrome\.scripting|executeScript|sendMessage|onUpdated|onMessage/);
    }
  });

  it("closing a tab nothing recorded (a restored or unrelated one) does nothing", async () => {
    const { onSessionTabClosed } = await openedSession();
    bridge.posted.length = 0;
    expect(await onSessionTabClosed(9999, bridge.client)).toBe(false);
    expect(bridge.posted).toEqual([]);
  });

  it("a tab closed while offline is reported once the runner is back, as the same event", async () => {
    const { readTabs, onSessionTabClosed } = await openedSession();
    const { flushAllSessions } = await import("./report");
    bridge.answer = () => ({ ok: false, error: { code: "network_error", message: "offline" } });
    const tabId = (await readTabs(SESSION_ID)).tabs[TASKS[0]]!;
    fake.closeTab(tabId);
    await onSessionTabClosed(tabId, bridge.client);
    const eventId = bridge.posted.at(-1)!.eventId;
    const back = fakeBridge();
    await flushAllSessions(back.client);
    expect(back.posted.map((event) => event.eventId)).toEqual([eventId]);
  });

  it("follows a replaced tab (prerendering swaps the ID), so its later close still counts", async () => {
    const { readTabs, onSessionTabReplaced, onSessionTabClosed } = await openedSession();
    const oldId = (await readTabs(SESSION_ID)).tabs[TASKS[2]]!;
    await onSessionTabReplaced(5000, oldId);
    expect((await readTabs(SESSION_ID)).tabs[TASKS[2]]).toBe(5000);
    bridge.posted.length = 0;
    expect(await onSessionTabClosed(5000, bridge.client)).toBe(true);
    expect(bridge.posted[0]).toMatchObject({ items: [{ taskId: TASKS[2], status: "closed" }] });
  });

  it("a tab closed while the opening is still running is named closed in the first report itself", async () => {
    await pair();
    bridge.commands = [command()];
    const { pollCommands, openSession, readTabs, onSessionTabClosed } = await modules();
    await pollCommands(bridge.client);
    fake.hooks.beforeCreate = async (index) => {
      if (index !== 2) return;
      const first = (await readTabs(SESSION_ID)).tabs[TASKS[0]]!;
      fake.closeTab(first);
      await onSessionTabClosed(first, bridge.client);
    };
    await openSession(SESSION_ID, "open", bridge.client);
    expect(bridge.posted).toEqual([
      expect.objectContaining({
        status: "completed",
        items: [
          { taskId: TASKS[0], status: "closed" },
          { taskId: TASKS[1], status: "opened" },
          { taskId: TASKS[2], status: "opened" },
        ],
      }),
    ]);
  });
});

describe("gate 3: after a browser restart only the manifest survives; reopening never adopts tabs", () => {
  async function restartedBrowser() {
    const loaded = await openedSession();
    // A restart: storage.session is wiped; storage.local survives. Chrome restores the tabs and the group
    // (with new IDs), which nothing recorded.
    const snapshot = fake.snapshot();
    snapshot.session = {};
    snapshot.tabs = new Map([...snapshot.tabs].map(([id, tab]) => [id + 1000, { ...tab, id: id + 1000 }]));
    vi.resetModules();
    fake = installFakeChrome(snapshot);
    await pair();
    return { ...loaded, ...(await modules()) };
  }

  it("a restored tab closing reports nothing, and the session still counts as opened", async () => {
    const { onSessionTabClosed, readSession } = await restartedBrowser();
    bridge.posted.length = 0;
    const restoredId = [...fake.state.tabs.keys()][0]!;
    fake.closeTab(restoredId);
    expect(await onSessionTabClosed(restoredId, bridge.client)).toBe(false);
    expect(bridge.posted).toEqual([]);
    expect((await readSession(SESSION_ID))?.phase).toBe("open");
  });

  it("Reopen with a group of the same title open warns first; opening anyway makes a new group, adopting none", async () => {
    const { openSession, readTabs } = await restartedBrowser();
    const restored = new Set(fake.state.tabs.keys());
    expect(await openSession(SESSION_ID, "reopen", bridge.client)).toEqual({ kind: "same_title", groups: 1 });
    expect(fake.calls.create).toBe(0);

    bridge.posted.length = 0;
    expect(await openSession(SESSION_ID, "reopen", bridge.client, { confirmSameTitle: true })).toMatchObject({ kind: "opened", opened: 3 });
    const recordedIds = Object.values((await readTabs(SESSION_ID)).tabs);
    expect(recordedIds).toHaveLength(3);
    for (const id of recordedIds) expect(restored.has(id), "never a restored tab").toBe(false);
    for (const id of restored) expect(fake.state.tabs.get(id)?.groupId, "restored tabs keep their own group").not.toBe((await readTabs(SESSION_ID)).groupId);
    expect(bridge.posted[0], "a later report on the same command").toMatchObject({ type: "browser_command_result", status: "completed" });
  });

  it("Reopen with no same-title group opens straight away", async () => {
    const { openSession } = await restartedBrowser();
    fake.state.groups.clear();
    expect(await openSession(SESSION_ID, "reopen", bridge.client)).toMatchObject({ kind: "opened", opened: 3 });
  });
});
