import "../shared/zod-jitless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { command, fakeBridge, installFakeChrome, pair, TASKS, type FakeChrome } from "./fake-chrome";

let fake: FakeChrome;

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
});

describe("the session poll alarm (15 minutes, recreated on startup)", () => {
  it("creates the repeating alarm, and leaves a correct one alone", async () => {
    const { ensureSessionPollAlarm, SESSION_POLL_ALARM } = await import("./poll-alarm");
    await ensureSessionPollAlarm();
    expect(fake.state.alarms.get(SESSION_POLL_ALARM)).toEqual({ delayInMinutes: 15, periodInMinutes: 15 });
    fake.state.alarms.set(SESSION_POLL_ALARM, { periodInMinutes: 15, when: 42 });
    await ensureSessionPollAlarm();
    expect(fake.state.alarms.get(SESSION_POLL_ALARM)).toEqual({ periodInMinutes: 15, when: 42 });
  });

  it("recreates an alarm with the wrong period", async () => {
    const { ensureSessionPollAlarm, SESSION_POLL_ALARM } = await import("./poll-alarm");
    fake.state.alarms.set(SESSION_POLL_ALARM, { periodInMinutes: 60 });
    await ensureSessionPollAlarm();
    expect(fake.state.alarms.get(SESSION_POLL_ALARM)).toEqual({ delayInMinutes: 15, periodInMinutes: 15 });
  });

  it("gate 4: waking to a queue of commands after being offline takes them all in and opens no tab, no group", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [
      command(),
      command({ commandId: "a1111111-1111-4111-8111-111111111111", sessionId: "b1111111-1111-4111-8111-111111111111" }),
      command({ commandId: "c1111111-1111-4111-8111-111111111111", sessionId: "d1111111-1111-4111-8111-111111111111" }),
    ];
    const { onSessionPollAlarm } = await import("./poll-alarm");
    const { listSessions } = await import("./store");
    expect(await onSessionPollAlarm(bridge.client)).toEqual({ kind: "ok", received: 3, refused: 0 });
    expect((await listSessions()).map((session) => session.phase)).toEqual(["waiting", "waiting", "waiting"]);
    expect(fake.calls).toEqual({ create: 0, group: 0, nameGroup: 0 });
    expect(fake.state.tabs.size).toBe(0);
  });

  it("marks an opening a killed side panel left behind as interrupted, and still opens nothing", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.commands = [command()];
    const { pollCommands } = await import("./receive");
    const { mutateSession, readSession } = await import("./store");
    await pollCommands(bridge.client);
    await mutateSession(command().sessionId, (session) => ({
      session: { ...session!, phase: "opening", attempt: { id: "e1111111-1111-4111-8111-111111111111", kind: "open", startedAt: new Date().toISOString(), taskIds: [...TASKS] } },
    }));
    const { onSessionPollAlarm } = await import("./poll-alarm");
    await onSessionPollAlarm(bridge.client);
    expect((await readSession(command().sessionId))?.phase).toBe("interrupted");
    expect(fake.calls.create).toBe(0);
  });

  it("an unreachable runner leaves the alarm armed for the next try", async () => {
    await pair();
    const bridge = fakeBridge();
    bridge.client.getCommands = async () => ({ ok: false, error: { code: "network_error", message: "offline" } });
    const { onSessionPollAlarm, SESSION_POLL_ALARM } = await import("./poll-alarm");
    expect((await onSessionPollAlarm(bridge.client)).kind).toBe("error");
    expect(fake.state.alarms.get(SESSION_POLL_ALARM)?.periodInMinutes).toBe(15);
  });
});
