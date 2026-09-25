import "../shared/zod-jitless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { command, fakeBridge, installFakeChrome, never, pair, TASKS, type FakeBridge, type FakeChrome, type FakeHooks } from "./fake-chrome";

/**
 * Gate 2 (browser-boundary.md): "Kill the worker after each checkpoint,
 * including the tab-created/journal-missing gap: recover or show an
 * explicit partial state."
 *
 * The opening runs in the side panel page that got the click. Each test
 * stops that context at one checkpoint -- the step it was on never returns
 * -- then starts a fresh context over what outlived it (storage and the
 * browser's tabs, exactly as a closed side panel or a reloaded page leaves
 * them, with no memory and no locks) and checks what it finds: the session
 * is either untouched or explicitly `interrupted`, what was recorded is
 * right, nothing opens by itself, and the person's next step does the
 * right thing.
 */

const SESSION_ID = command().sessionId;

let fake: FakeChrome;
let bridge: FakeBridge;

async function freshModules() {
  const open = await import("./open");
  const store = await import("./store");
  const receive = await import("./receive");
  const report = await import("./report");
  return { ...open, ...store, ...receive, ...report };
}

beforeEach(async () => {
  vi.resetModules();
  fake = installFakeChrome();
  bridge = fakeBridge();
  await pair();
  bridge.commands = [command()];
  const { pollCommands } = await freshModules();
  await pollCommands(bridge.client);
});

/** Starts opening in the first context and returns once it is stuck at the hook; the context then "dies". */
async function killAt(install: (hooks: FakeHooks, reached: () => void) => void): Promise<void> {
  const { openSession } = await freshModules();
  let reached!: () => void;
  const stuck = new Promise<void>((resolve) => {
    reached = resolve;
  });
  install(fake.hooks, reached);
  void openSession(SESSION_ID, "open", bridge.client);
  await stuck;
}

/** A new context over what outlived the killed one: storage, tabs and groups; no module state, no locks. */
async function restart(): Promise<Awaited<ReturnType<typeof freshModules>>> {
  const snapshot = fake.snapshot();
  vi.resetModules();
  fake = installFakeChrome(snapshot);
  return freshModules();
}

function recorded(modules: Awaited<ReturnType<typeof freshModules>>) {
  return modules.readTabs(SESSION_ID);
}

describe("gate 2: the opening context killed after each checkpoint", () => {
  it("killed before the journal is written: the session is still waiting, untouched, and nothing is open", async () => {
    await killAt((hooks, reached) => {
      hooks.beforeLocalSet = (items) => {
        const written = Object.values(items)[0] as { phase?: string } | undefined;
        if (written?.phase === "opening") {
          reached();
          return never();
        }
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([]);
    expect((await modules.readSession(SESSION_ID))?.phase).toBe("waiting");
    expect(fake.state.tabs.size).toBe(0);
  });

  it("killed after the journal, before the first tab: interrupted, nothing recorded, nothing open; 'Open the missing tabs' opens each once", async () => {
    await killAt((hooks, reached) => {
      hooks.beforeCreate = () => {
        reached();
        return never();
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([SESSION_ID]);
    expect((await modules.readSession(SESSION_ID))?.phase).toBe("interrupted");
    expect((await recorded(modules)).tabs).toEqual({});
    expect(fake.state.tabs.size).toBe(0);
    expect(fake.calls.create, "recovery opens nothing by itself").toBe(0);

    expect(await modules.openSession(SESSION_ID, "resume", bridge.client)).toMatchObject({ kind: "opened", opened: 3, failed: 0, grouped: true });
    expect(fake.state.tabs.size).toBe(3);
    expect(Object.keys((await recorded(modules)).tabs).sort()).toEqual([...TASKS].sort());
    expect(bridge.posted.at(-1)).toMatchObject({ type: "browser_command_result", status: "completed", items: TASKS.map((taskId) => ({ taskId, status: "opened" })) });
  });

  it("killed in the gap -- the second tab created, its ID never recorded: interrupted, 1 of 3 recorded, the orphan left alone; keeping what opened reports the rest as skipped", async () => {
    await killAt((hooks, reached) => {
      hooks.afterCreate = (_tab, index) => {
        if (index === 1) {
          reached();
          return never();
        }
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([SESSION_ID]);
    expect(fake.state.tabs.size, "two tabs exist: one recorded, one orphan").toBe(2);
    const tabs = await recorded(modules);
    expect(Object.keys(tabs.tabs)).toEqual([TASKS[0]]);
    const orphan = [...fake.state.tabs.keys()].find((id) => id !== tabs.tabs[TASKS[0]])!;

    // The orphan closing is nothing to this browser: it was never recorded.
    const { onSessionTabClosed } = await import("./tabs");
    const postedBefore = bridge.posted.length;
    fake.closeTab(orphan);
    expect(await onSessionTabClosed(orphan, bridge.client)).toBe(false);
    expect(bridge.posted.length).toBe(postedBefore);

    expect(await modules.settleInterrupted(SESSION_ID, bridge.client)).toBe(true);
    expect((await modules.readSession(SESSION_ID))?.phase).toBe("open");
    expect(bridge.posted.at(-1)).toMatchObject({
      type: "browser_command_result",
      status: "partial",
      items: [
        { taskId: TASKS[0], status: "opened" },
        { taskId: TASKS[1], status: "skipped" },
        { taskId: TASKS[2], status: "skipped" },
      ],
    });
    expect(fake.calls.create, "no tab opened after the kill").toBe(0);
  });

  it("killed in the gap, then 'Open the missing tabs': only the unrecorded ones open (the person was warned one may be a duplicate)", async () => {
    await killAt((hooks, reached) => {
      hooks.afterCreate = (_tab, index) => {
        if (index === 1) {
          reached();
          return never();
        }
      };
    });
    const modules = await restart();
    await modules.recoverInterrupted();
    expect(await modules.openSession(SESSION_ID, "resume", bridge.client)).toMatchObject({ kind: "opened", opened: 2 });
    expect(fake.calls.create).toBe(2);
    expect(Object.keys((await recorded(modules)).tabs).sort()).toEqual([...TASKS].sort());
    const [report] = bridge.posted;
    expect(report).toMatchObject({ type: "browser_command_result", status: "completed" });
  });

  it("killed after every tab was recorded, before grouping: interrupted with all three recorded; keeping them reports them opened", async () => {
    await killAt((hooks, reached) => {
      hooks.beforeGroup = () => {
        reached();
        return never();
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([SESSION_ID]);
    expect(Object.keys((await recorded(modules)).tabs)).toHaveLength(3);
    expect(await modules.settleInterrupted(SESSION_ID, bridge.client)).toBe(true);
    expect(bridge.posted.at(-1)).toMatchObject({ status: "completed", items: TASKS.map((taskId) => ({ taskId, status: "opened" })) });
  });

  it("killed after grouping, before the group was named: interrupted, the group ID recorded", async () => {
    await killAt((hooks, reached) => {
      hooks.beforeNameGroup = () => {
        reached();
        return never();
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([SESSION_ID]);
    expect((await recorded(modules)).groupId).toBeDefined();
    expect(fake.state.tabs.size).toBe(3);
  });

  it("killed after the session was marked opened, while its report was being sent: not interrupted; the next flush sends the same event, once", async () => {
    let stuckReport: string | undefined;
    await killAt((_hooks, reached) => {
      bridge.answer = (event) => {
        stuckReport = event.eventId;
        reached();
        return never() as never;
      };
    });
    const modules = await restart();
    expect(await modules.recoverInterrupted()).toEqual([]);
    const session = await modules.readSession(SESSION_ID);
    expect(session?.phase).toBe("open");
    expect(session?.events.map((entry) => entry.state)).toEqual(["pending"]);

    const second = fakeBridge();
    await modules.flushAllSessions(second.client);
    expect(second.posted.map((event) => event.eventId)).toEqual([stuckReport]);
    expect((await modules.readSession(SESSION_ID))?.events.map((entry) => entry.state)).toEqual(["accepted"]);
    await modules.flushAllSessions(second.client);
    expect(second.posted, "sent once").toHaveLength(1);
  });

  it("a second click while one context is opening the session is refused as busy, never a second group", async () => {
    const { openSession } = await freshModules();
    let release!: () => void;
    fake.hooks.beforeCreate = (index) => (index === 0 ? new Promise<void>((resolve) => (release = resolve)) : undefined);
    const first = openSession(SESSION_ID, "open", bridge.client);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await openSession(SESSION_ID, "open", bridge.client)).toEqual({ kind: "busy" });
    release();
    expect(await first).toMatchObject({ kind: "opened", opened: 3 });
    expect(fake.calls.group).toBe(1);
    expect(await openSession(SESSION_ID, "open", bridge.client), "an opened session isn't opened again").toEqual({ kind: "not_now" });
  });
});

describe("opening: what it records, and the URLs it will open", () => {
  it("journals before the first tab, records each tab ID before the next is created, names the group with the session's title, then reports every task", async () => {
    const { openSession, readSession, readTabs } = await freshModules();
    const order: string[] = [];
    fake.hooks.beforeCreate = async (index) => {
      order.push(`create ${index}: phase ${(await readSession(SESSION_ID))?.phase}, recorded ${Object.keys((await readTabs(SESSION_ID)).tabs).length}`);
    };
    expect(await openSession(SESSION_ID, "open", bridge.client)).toMatchObject({ kind: "opened", opened: 3, grouped: true });
    expect(order).toEqual(["create 0: phase opening, recorded 0", "create 1: phase opening, recorded 1", "create 2: phase opening, recorded 2"]);
    const tabs = await readTabs(SESSION_ID);
    expect(fake.state.groups.get(tabs.groupId!)).toMatchObject({ title: "Apply today" });
    expect([...fake.state.tabs.values()].every((tab) => tab.groupId === tabs.groupId)).toBe(true);
    expect([...fake.state.tabs.values()].filter((tab) => tab.active)).toHaveLength(1);
    expect(bridge.posted).toEqual([expect.objectContaining({ type: "browser_command_result", commandId: command().commandId, status: "completed", items: TASKS.map((taskId) => ({ taskId, status: "opened" })) })]);
    expect((await readSession(SESSION_ID))?.items.map((item) => item.revision)).toEqual([1, 1, 1]);
  });

  it("checks every URL again right before opening it: a stored record edited to a private address is never opened", async () => {
    const { openSession, mutateSession, readSession } = await freshModules();
    await mutateSession(SESSION_ID, (session) => ({ session: { ...session!, items: session!.items.map((item, index) => (index === 1 ? { ...item, url: "https://192.168.1.1/admin" } : item)) } }));
    expect(await openSession(SESSION_ID, "open", bridge.client)).toMatchObject({ kind: "opened", opened: 2 });
    expect([...fake.state.tabs.values()].map((tab) => tab.url)).not.toContain("https://192.168.1.1/admin");
    expect((await readSession(SESSION_ID))?.items[1]?.urlProblem).toBe("private_host");
    expect(bridge.posted[0]).toMatchObject({ status: "partial", items: [{ status: "opened" }, { status: "skipped" }, { status: "opened" }] });
  });

  it("won't open a bridge session whose command expired while it waited", async () => {
    const { openSession, readSession } = await freshModules();
    const later = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await openSession(SESSION_ID, "open", bridge.client, { now: later })).toEqual({ kind: "expired" });
    expect(await readSession(SESSION_ID)).toMatchObject({ phase: "refused", refusal: "expired" });
    expect(fake.calls.create).toBe(0);
  });
});
