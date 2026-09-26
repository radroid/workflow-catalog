import "../shared/zod-jitless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeResult, PostEventResult } from "../shared/bridge-client";
import { command, fakeBridge, installFakeChrome, OTHER_DEVICE_ID, pair, TASKS, type FakeBridge } from "./fake-chrome";

const SESSION_ID = command().sessionId;

let bridge: FakeBridge;

async function modules() {
  const open = await import("./open");
  const store = await import("./store");
  const receive = await import("./receive");
  const report = await import("./report");
  return { ...open, ...store, ...receive, ...report };
}

/** Pairs, takes the command in and opens it, the way a click on Start applying does. */
async function openedSession(): Promise<Awaited<ReturnType<typeof modules>>> {
  await pair();
  bridge.commands = [command()];
  const loaded = await modules();
  await loaded.pollCommands(bridge.client);
  await loaded.openSession(SESSION_ID, "open", bridge.client);
  return loaded;
}

const offline = (): BridgeResult<PostEventResult> => ({ ok: false, error: { code: "network_error", message: "Can't reach the runner." } });

beforeEach(() => {
  vi.resetModules();
  installFakeChrome();
  bridge = fakeBridge();
});

describe("the first report names every task, and its answer is where each application's revision comes from", () => {
  it("keeps the revision and stage the runner answered, never the job revision", async () => {
    bridge.revisions.set(TASKS[1], 4);
    bridge.stages.set(TASKS[1], "ready");
    const { readSession } = await openedSession();
    const items = (await readSession(SESSION_ID))!.items;
    expect(items.map((item) => [item.jobRevision, item.revision])).toEqual([
      [1, 1],
      [1, 4],
      [1, 1],
    ]);
    expect(items[1]?.stage).toBe("ready");
  });

  it("an answer that isn't shaped like the runner's changes no revision (the choice then waits for a refresh)", async () => {
    bridge.answer = () => ({ ok: true, value: { duplicate: false, result: { items: [{ taskId: TASKS[0], stage: "ready", revision: "one" }] } } });
    const { readSession, chooseStatus } = await openedSession();
    expect((await readSession(SESSION_ID))!.items.every((item) => item.revision === undefined)).toBe(true);
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "no_revision" });
    expect(bridge.posted.filter((event) => event.type === "application_status_changed")).toEqual([]);
  });

  it("a replayed report's older answer never lowers a revision already known", async () => {
    const { readSession, flushSession, mutateSession, withQueuedEvent, buildReport } = await openedSession();
    await mutateSession(SESSION_ID, (session) => ({ session: { ...session!, items: session!.items.map((item) => ({ ...item, revision: 5 })) } }));
    bridge.revisions.set(TASKS[0], 2);
    await mutateSession(SESSION_ID, (session) => ({ session: withQueuedEvent(session!, buildReport(session!, [{ taskId: TASKS[0], status: "opened" }], "completed")) }));
    await flushSession(SESSION_ID, bridge.client);
    expect((await readSession(SESSION_ID))!.items[0]?.revision).toBe(5);
  });
});

describe("Applied and Defer: the only status the extension sends, with the application's expected revision", () => {
  it("Applied sends application_status_changed with expectedRevision and records the runner's outcome and new revision", async () => {
    const { chooseStatus, readSession } = await openedSession();
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "recorded", outcome: "applied" });
    const sent = bridge.posted.at(-1);
    expect(sent).toMatchObject({ type: "application_status_changed", taskId: TASKS[0], expectedRevision: 1, status: "applied" });
    const item = (await readSession(SESSION_ID))!.items[0]!;
    expect(item).toMatchObject({ revision: 2, stage: "applied", choice: { status: "applied", outcome: "applied" } });
  });

  it("Defer sends deferred; the stage stays", async () => {
    const { chooseStatus, readSession } = await openedSession();
    expect(await chooseStatus(SESSION_ID, TASKS[1], "deferred", bridge.client)).toEqual({ kind: "recorded", outcome: "deferred" });
    expect(bridge.posted.at(-1)).toMatchObject({ type: "application_status_changed", taskId: TASKS[1], status: "deferred", expectedRevision: 1 });
    expect((await readSession(SESSION_ID))!.items[1]).toMatchObject({ stage: "ready", revision: 1, choice: { outcome: "deferred" } });
  });

  it("a stale revision (409) is not retried: the choice is refused and says so; a refresh fetches the current revision, and the next press names it", async () => {
    const { chooseStatus, readSession, refreshRevisions, flushAllSessions } = await openedSession();
    bridge.revisions.set(TASKS[0], 3); // The person changed it on the Board meanwhile.
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "problem", problem: "stale_revision" });
    const refused = (await readSession(SESSION_ID))!;
    expect(refused.items[0]?.choiceProblem).toBe("stale_revision");
    expect(refused.events.at(-1)).toMatchObject({ state: "refused", code: "stale_revision" });
    const sentBefore = bridge.posted.length;
    await flushAllSessions(bridge.client);
    expect(bridge.posted.length, "a refused choice is never sent again").toBe(sentBefore);

    expect(await refreshRevisions(SESSION_ID, [TASKS[0]], bridge.client)).toEqual({ kind: "refreshed" });
    expect(bridge.posted.at(-1)).toMatchObject({ type: "browser_command_result", status: "completed", items: [{ taskId: TASKS[0], status: "opened" }] });
    expect((await readSession(SESSION_ID))!.items[0]).toMatchObject({ revision: 3 });
    expect((await readSession(SESSION_ID))!.items[0]?.choiceProblem).toBeUndefined();

    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "recorded", outcome: "applied" });
    expect(bridge.posted.at(-1)).toMatchObject({ type: "application_status_changed", expectedRevision: 3 });
  });

  it("the runner unreachable: the choice waits as pending and goes again later as the same event; pressing again reuses it", async () => {
    const { chooseStatus, readSession, flushAllSessions } = await openedSession();
    bridge.answer = offline;
    expect(await chooseStatus(SESSION_ID, TASKS[2], "applied", bridge.client)).toEqual({ kind: "problem", problem: "unreachable" });
    const firstId = bridge.posted.at(-1)!.eventId;
    expect(await chooseStatus(SESSION_ID, TASKS[2], "applied", bridge.client)).toEqual({ kind: "problem", problem: "unreachable" });
    expect(bridge.posted.at(-1)!.eventId, "the same eventId, so the runner applies it once").toBe(firstId);

    const back = fakeBridge();
    await flushAllSessions(back.client);
    expect(back.posted.map((event) => event.eventId)).toEqual([firstId]);
    expect((await readSession(SESSION_ID))!.items[2]).toMatchObject({ choice: { outcome: "applied" } });
  });

  it("changing the choice while the first is still pending replaces it: the older event is never sent again", async () => {
    const { chooseStatus, readSession, flushAllSessions } = await openedSession();
    bridge.answer = offline;
    await chooseStatus(SESSION_ID, TASKS[0], "deferred", bridge.client);
    const deferId = bridge.posted.at(-1)!.eventId;
    await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client);
    const back = fakeBridge();
    await flushAllSessions(back.client);
    expect(back.posted.map((event) => (event.type === "application_status_changed" ? event.status : event.type))).toEqual(["applied"]);
    expect((await readSession(SESSION_ID))!.events.find((entry) => entry.event.eventId === deferId)).toMatchObject({ state: "refused", code: "replaced" });
  });

  it("a runner that says the choice was a replay answers duplicate; the outcome is still recorded once", async () => {
    const { chooseStatus } = await openedSession();
    const inner = bridge.answer;
    bridge.answer = async (event) => {
      const answered = await inner(event);
      return answered.ok && event.type === "application_status_changed" ? { ok: true, value: { ...answered.value, duplicate: true } } : answered;
    };
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "recorded", outcome: "applied" });
  });

  it("gate 6: after pairing again as another device, a choice on the old device's session is not sent", async () => {
    const { chooseStatus } = await openedSession();
    await pair(OTHER_DEVICE_ID);
    const sentBefore = bridge.posted.length;
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "other_pairing" });
    await chrome.storage.session.remove("deviceToken");
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "not_paired" });
    expect(bridge.posted.length).toBe(sentBefore);
  });

  it("gate 6: a revoked token (401) keeps the choice pending for a new pairing, never dropped", async () => {
    const { chooseStatus, readSession } = await openedSession();
    bridge.answer = () => ({ ok: false, error: { status: 401, code: "token_invalid", message: "revoked" } });
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toMatchObject({ kind: "problem" });
    expect((await readSession(SESSION_ID))!.events.at(-1)?.state).toBe("pending");
  });

  it("a session the runner no longer takes reports on (410 command_expired on the first report) stops every later event", async () => {
    await pair();
    bridge.commands = [command()];
    const { pollCommands, openSession, readSession, chooseStatus } = await modules();
    await pollCommands(bridge.client);
    bridge.answer = () => ({ ok: false, error: { status: 410, code: "command_expired", message: "expired" } });
    await openSession(SESSION_ID, "open", bridge.client);
    const session = (await readSession(SESSION_ID))!;
    expect(session.reportProblem).toBe("expired");
    expect(session.events.map((entry) => entry.state)).toEqual(["refused"]);
    const sentBefore = bridge.posted.length;
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "report_problem", problem: "expired" });
    expect(bridge.posted.length).toBe(sentBefore);
  });
});

describe("a session from a file (no command, no bridge): choices stay in this browser", () => {
  it("records Applied locally, sends nothing, and exports it as a completion event for the runner's inbox", async () => {
    const { importManifest, openSession, chooseStatus, readSession } = await modules();
    await importManifest({ protocol: 1, sessionId: SESSION_ID, title: "From a file", items: command().payload.items, createdAt: "2026-09-24T09:00:00.000Z" });
    expect(await openSession(SESSION_ID, "open", bridge.client)).toMatchObject({ kind: "opened", opened: 3 });
    expect(await chooseStatus(SESSION_ID, TASKS[0], "applied", bridge.client)).toEqual({ kind: "local" });
    expect(bridge.posted).toEqual([]);
    const session = (await readSession(SESSION_ID))!;
    expect(session.items[0]?.choice).toMatchObject({ status: "applied", outcome: "local" });
    expect(session.events, "a file session has no command to report on").toEqual([]);
  });
});
