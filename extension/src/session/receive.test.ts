import "../shared/zod-jitless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { command, DEVICE_ID, fakeBridge, installFakeChrome, OTHER_DEVICE_ID, pair, TASKS, type FakeChrome } from "./fake-chrome";

let fake: FakeChrome;

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
});

async function modules() {
  const receive = await import("./receive");
  const store = await import("./store");
  return { ...receive, ...store };
}

describe("taking sessions in: a poll stores them as ready to open, and opens nothing (F9: only a click opens a group)", () => {
  it("stores the command as a waiting session, remembers its commandId, and creates no tab and no group", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [command()];
    const { pollCommands, listSessions, sessionIdForCommand } = await modules();

    expect(await pollCommands(bridge.client)).toEqual({ kind: "ok", received: 1, refused: 0 });
    const [session] = await listSessions();
    expect(session).toMatchObject({ phase: "waiting", source: "bridge", title: "Apply today", deviceId: DEVICE_ID, commandId: command().commandId });
    expect(session!.items.map((item) => item.taskId)).toEqual([...TASKS]);
    expect(await sessionIdForCommand(command().commandId)).toBe(command().sessionId);
    expect(fake.calls).toEqual({ create: 0, group: 0, nameGroup: 0 });
    expect(bridge.posted, "nothing to report until something opens").toEqual([]);
  });

  it("does nothing while unpaired, and never calls the bridge", async () => {
    const bridge = fakeBridge();
    const getCommands = vi.spyOn(bridge.client, "getCommands");
    const { pollCommands, listSessions } = await modules();
    expect(await pollCommands(bridge.client)).toEqual({ kind: "not_paired" });
    expect(getCommands).not.toHaveBeenCalled();
    expect(await listSessions()).toEqual([]);
  });
});

describe("gate 1 (replay): a command sent again, or the same session by file, is taken in once", () => {
  it("a command the bridge sends again after its lease lapsed changes nothing, even once the session was opened and reported", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [command()];
    const { pollCommands, listSessions } = await modules();
    await pollCommands(bridge.client);
    const first = await listSessions();

    expect(await pollCommands(bridge.client)).toEqual({ kind: "ok", received: 0, refused: 0 });
    expect(await listSessions()).toEqual(first);
    expect(fake.calls.create).toBe(0);
  });

  it("a file copy of a session that came by command changes nothing", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [command()];
    const { pollCommands, importManifest, listSessions } = await modules();
    await pollCommands(bridge.client);
    const before = await listSessions();
    const outcome = await importManifest({ protocol: 1, sessionId: command().sessionId, title: "An older copy", items: command().payload.items, createdAt: "2026-09-24T09:00:00.000Z" });
    expect(outcome.kind).toBe("already_here");
    expect(await listSessions()).toEqual(before);
  });

  it("a command for a session first imported from a file attaches to it: one session, and an opened one is reported, not opened again", async () => {
    await pair();
    const { importManifest, pollCommands, listSessions, mutateSession } = await modules();
    await importManifest({ protocol: 1, sessionId: command().sessionId, title: "Apply today", items: command().payload.items, createdAt: "2026-09-24T09:00:00.000Z" });
    // Say the person opened it from the file already (two tabs recorded).
    await mutateSession(command().sessionId, (session) => ({
      session: { ...session!, phase: "open", items: session!.items.map((item, index) => (index < 2 ? { ...item, tab: "opened" as const } : item)) },
      tabs: { tabs: { [TASKS[0]]: 100, [TASKS[1]]: 101 } },
    }));
    const bridge = fakeBridge();
    bridge.commands = [command()];
    expect(await pollCommands(bridge.client)).toEqual({ kind: "ok", received: 1, refused: 0 });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ source: "bridge", commandId: command().commandId, phase: "open" });
    expect(fake.calls.create).toBe(0);
    expect(bridge.posted).toEqual([
      expect.objectContaining({
        type: "browser_command_result",
        commandId: command().commandId,
        status: "partial",
        items: [
          { taskId: TASKS[0], status: "opened" },
          { taskId: TASKS[1], status: "opened" },
          { taskId: TASKS[2], status: "skipped" },
        ],
      }),
    ]);
  });
});

describe("gate 6 and gate 7: commands this browser won't act on", () => {
  it("keeps another device's command and an expired one as refused, opens nothing, and reports neither", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [
      command({ commandId: "11111111-1111-4111-8111-111111111111", sessionId: "21111111-1111-4111-8111-111111111111", deviceId: OTHER_DEVICE_ID }),
      command({ commandId: "31111111-1111-4111-8111-111111111111", sessionId: "41111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ];
    const { pollCommands, listSessions } = await modules();
    expect(await pollCommands(bridge.client)).toEqual({ kind: "ok", received: 0, refused: 2 });
    const refusals = (await listSessions()).map((session) => [session.phase, session.refusal]).sort();
    expect(refusals).toEqual([
      ["refused", "expired"],
      ["refused", "other_device"],
    ]);
    expect(fake.calls.create).toBe(0);
    expect(bridge.posted).toEqual([]);
  });

  it("reports a live command for this device it won't open (an unknown workflow major, or no safe address) as failed, every item skipped, so the runner flags it and stops sending it", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [
      command({ workflowVersion: "job-assistant@7" }),
      command(
        { commandId: "51111111-1111-4111-8111-111111111111", sessionId: "61111111-1111-4111-8111-111111111111" },
        [{ taskId: TASKS[0], jobRevision: 1, url: "https://169.254.169.254/latest/meta-data" }],
      ),
    ];
    const { pollCommands } = await modules();
    expect(await pollCommands(bridge.client)).toEqual({ kind: "ok", received: 0, refused: 2 });
    const reported = bridge.posted.map((event) => (event.type === "browser_command_result" ? `${event.status}: ${event.items.map((item) => item.status).join(",")}` : event.type));
    expect(reported.sort()).toEqual(["failed: skipped", "failed: skipped,skipped,skipped"]);
    expect(fake.calls.create).toBe(0);
  });

  it("a file manifest's unsafe addresses are marked, and one with nothing safe to open is refused", async () => {
    const { importManifest } = await modules();
    const mixed = await importManifest({
      protocol: 1,
      sessionId: "71111111-1111-4111-8111-111111111111",
      title: "Mixed",
      items: [
        { taskId: TASKS[0], jobRevision: 1, url: "https://jobs.example/a" },
        { taskId: TASKS[1], jobRevision: 1, url: "http://10.0.0.8/postings/harbor-sre" },
      ],
      createdAt: "2026-09-24T09:00:00.000Z",
    });
    expect(mixed.kind).toBe("added");
    expect(mixed.session.items.map((item) => item.urlProblem)).toEqual([undefined, "not_https"]);
    const none = await importManifest({
      protocol: 1,
      sessionId: "81111111-1111-4111-8111-111111111111",
      title: "None",
      items: [{ taskId: TASKS[0], jobRevision: 1, url: "https://localhost/a" }],
      createdAt: "2026-09-24T09:00:00.000Z",
    });
    expect(none).toMatchObject({ kind: "refused", session: { phase: "refused", refusal: "no_openable_item" } });
  });
});
