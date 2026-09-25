import { readFile } from "node:fs/promises";
import { commandsResponseSchema, MAX_APPLICATION_GROUP_SIZE, openApplicationGroupSchema, sessionManifestSchema, type Application } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../lib/clock.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { handleCommandResult } from "../server/routes/commands.ts";
import { ApplicationsStore, applicationPath } from "../store/applications.ts";
import { COMMAND_TTL_MS, OUTBOX_DIR, OUTBOX_FILE, SessionsStore, commandUrlProblem, decideStatusChange } from "../store/sessions.ts";
import { authed, BRIDGE, makeBridge, OTHER_EXTENSION_ORIGIN, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";
import { FERNWOOD_JOB, fixtureJob, platformLeadJob } from "./preparation-helpers.ts";
import { commandResult, postingFor, seedApplication, SESSION_MODULES, statusChanged } from "./session-helpers.ts";

/**
 * P06's acceptance, through the real bridge: sessions made from Ready applications, the command the paired
 * browser leases, and the two events that report back (`browser_command_result`, `application_status_changed`).
 * Fictional data only.
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function bridge(): Promise<TestBridge> {
  return makeBridge({ modules: SESSION_MODULES });
}

async function startSession(b: TestBridge, taskIds: readonly string[], title?: string) {
  const response = await b.request("/api/sessions", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ taskIds, ...(title ? { title } : {}) }) });
  return { status: response.status, body: (await response.json()) as { ok: boolean; sessionId: string; sent: boolean; error?: { code: string; message: string; taskId?: string } } };
}

async function applicationBytes(b: TestBridge, taskId: string): Promise<string> {
  return readFile(await b.workspace.resolveReal(...applicationPath(taskId).split("/")), "utf8");
}

async function application(b: TestBridge, taskId: string): Promise<Application> {
  return (await new ApplicationsStore(b.workspace, b.clock).get(taskId))!;
}

async function leased(b: TestBridge, token: string, origin?: string) {
  const response = await b.request("/commands", { headers: authed(token, origin) });
  expect(response.status).toBe(200);
  return commandsResponseSchema.parse(await response.json()).commands;
}

describe("sessions: starting one from Ready applications", () => {
  it("writes the manifest and queues one command for the paired browser: expiry, workflow version, device, and each stored job URL", async () => {
    const b = await bridge();
    const { deviceId, token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    // Fernwood's posting names a separate apply address; nothing a posting says may become a navigation target.
    const fernwood = await seedApplication(b.workspace, b.clock, fixtureJob(FERNWOOD_JOB));
    const started = await startSession(b, [lead.taskId, fernwood.taskId], "Apply today");
    expect(started.status).toBe(200);
    expect(started.body.sent).toBe(true);

    const manifest = sessionManifestSchema.parse(await b.workspace.readJson("sessions", `${started.body.sessionId}.json`));
    expect(manifest.items).toEqual([
      { taskId: lead.taskId, jobRevision: 1, url: "https://jobs.example/postings/fernwood-platform-lead" },
      { taskId: fernwood.taskId, jobRevision: 1, url: FERNWOOD_JOB.url },
    ]);
    const [command] = await leased(b, token);
    expect(openApplicationGroupSchema.parse(command)).toMatchObject({
      deviceId,
      sessionId: started.body.sessionId,
      workflowVersion: "job-assistant@0",
      expiresAt: new Date(b.clock.now().getTime() + COMMAND_TTL_MS).toISOString(),
      payload: { title: "Apply today", items: manifest.items },
    });
    expect(JSON.stringify(command)).not.toContain(FERNWOOD_JOB.structured.applyUrl!);
    for (const item of command!.payload.items) expect(item.url.startsWith("https://")).toBe(true);
  });

  it("refuses an application that isn't Ready, more than the group size, a stored URL that isn't public https, and a task already waiting to open", async () => {
    const b = await bridge();
    await pairDevice(b);
    const saved = await seedApplication(b.workspace, b.clock, postingFor("Data Engineer", "Ledgerkit"), "saved");
    expect((await startSession(b, [saved.taskId])).body.error).toMatchObject({ code: "not_ready", taskId: saved.taskId, message: "“Data Engineer · Ledgerkit” isn't Ready, so it can't go in a session." });

    const http = await seedApplication(b.workspace, b.clock, postingFor("QA Engineer", "Quill", "http://jobs.example/postings/quill-qa"));
    expect((await startSession(b, [http.taskId])).body.error).toMatchObject({ code: "url_not_allowed", taskId: http.taskId });
    const local = await seedApplication(b.workspace, b.clock, postingFor("SRE", "Harbor", "https://10.0.0.8/postings/harbor-sre"));
    expect((await startSession(b, [local.taskId])).body.error).toMatchObject({ code: "url_not_allowed" });

    const many = Array.from({ length: MAX_APPLICATION_GROUP_SIZE + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(await startSession(b, many)).toMatchObject({ status: 400, body: { error: { code: "too_many" } } });

    const ready = await seedApplication(b.workspace, b.clock, platformLeadJob());
    expect((await startSession(b, [ready.taskId])).status).toBe(200);
    expect((await startSession(b, [ready.taskId])).body.error).toMatchObject({ code: "already_waiting", taskId: ready.taskId });
    expect((await new SessionsStore(b.workspace, b.clock).list()).sessions).toHaveLength(1);
  });

  it("with no paired browser, writes the manifest to outbox/ and queues no command", async () => {
    const b = await bridge();
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    const started = await startSession(b, [lead.taskId]);
    expect(started.body).toMatchObject({ ok: true, sent: false });
    const outbox = sessionManifestSchema.parse(await b.workspace.readJson(OUTBOX_DIR, OUTBOX_FILE));
    expect(outbox.sessionId).toBe(started.body.sessionId);
    expect(await b.ctx.commands.list()).toEqual([]);
  });

  it("checks every command URL: https to a public host only", () => {
    expect(commandUrlProblem("https://jobs.example/postings/quill")).toBeUndefined();
    for (const url of ["http://jobs.example/a", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "https://localhost/a", "https://127.0.0.1/a", "https://169.254.169.254/latest", "https://[::1]/a", "https://intranet/a", "https://user:pw@jobs.example/a", "https://printer.local/a"]) {
      expect(commandUrlProblem(url), url).toBeDefined();
    }
  });
});

describe("sessions: expired commands and other devices' tasks are refused (acceptance)", () => {
  it("never delivers an expired command, and refuses a first report on one", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await b.ctx.commands.list();
    b.clock.advance(COMMAND_TTL_MS);
    expect(await leased(b, token)).toEqual([]);
    const before = await applicationBytes(b, lead.taskId);
    const response = await postEvent(b, token, commandResult(command!.command.commandId, [[lead.taskId, "opened"]]));
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("command_expired");
    expect(await applicationBytes(b, lead.taskId)).toBe(before);
    expect((await new SessionsStore(b.workspace, b.clock).list()).sessions[0]!.results).toEqual([]);
    expect((await b.ctx.commands.get(command!.command.commandId))?.acknowledgedAt).toBeUndefined();
  });

  it("delivers a command only to its own device, and refuses another device's report on it or status for its task", async () => {
    const b = await bridge();
    const other = await pairDevice(b, OTHER_EXTENSION_ORIGIN);
    b.clock.advance(MINUTE_MS); // the test clock stands still: without this, the two pairings tie
    const mine = await pairDevice(b); // paired last: sessions go to it
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    expect(await leased(b, other.token, OTHER_EXTENSION_ORIGIN)).toEqual([]);
    const [command] = await leased(b, mine.token);
    expect(command!.deviceId).toBe(mine.deviceId);

    const before = await applicationBytes(b, lead.taskId);
    const report = await postEvent(b, other.token, commandResult(command!.commandId, [[lead.taskId, "opened"]]), OTHER_EXTENSION_ORIGIN);
    expect(report.status).toBe(403);
    expect(((await report.json()) as { error: { code: string } }).error.code).toBe("command_not_for_device");
    const status = await postEvent(b, other.token, statusChanged(lead.taskId, lead.application.revision), OTHER_EXTENSION_ORIGIN);
    expect(status.status).toBe(403);
    expect(((await status.json()) as { error: { code: string } }).error.code).toBe("task_not_for_device");
    expect(await applicationBytes(b, lead.taskId)).toBe(before);
    expect((await b.ctx.commands.get(command!.commandId))?.acknowledgedAt).toBeUndefined();
  });

  it("accepts a later report (a tab closed) on a command reported before it expired", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await leased(b, token);
    expect((await postEvent(b, token, commandResult(command!.commandId, [[lead.taskId, "opened"]]))).status).toBe(200);
    b.clock.advance(COMMAND_TTL_MS + MINUTE_MS);
    expect((await postEvent(b, token, commandResult(command!.commandId, [[lead.taskId, "closed"]]))).status).toBe(200);
  });
});

describe("sessions: a closed tab changes nothing; only the person's explicit status moves the stage (acceptance)", () => {
  it("records the browser's tabs, flags a closed one for review, and leaves the application byte-identical", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    const harbor = await seedApplication(b.workspace, b.clock, postingFor("Platform Engineer", "Harbor"));
    await startSession(b, [lead.taskId, harbor.taskId]);
    const [command] = await leased(b, token);
    const before = [await applicationBytes(b, lead.taskId), await applicationBytes(b, harbor.taskId)];

    const opened = await postEvent(b, token, commandResult(command!.commandId, [[lead.taskId, "opened"], [harbor.taskId, "opened"]]));
    expect(opened.status).toBe(200);
    // The result tells the extension each application's revision, for the status it sends next.
    expect(((await opened.json()) as { result: unknown }).result).toEqual({
      sessionId: command!.sessionId,
      items: [
        { taskId: lead.taskId, stage: "ready", revision: lead.application.revision },
        { taskId: harbor.taskId, stage: "ready", revision: harbor.application.revision },
      ],
      flagged: 0,
    });
    expect((await b.ctx.commands.get(command!.commandId))?.acknowledgedAt).toBeDefined();

    const closed = await postEvent(b, token, commandResult(command!.commandId, [[lead.taskId, "closed"], [harbor.taskId, "closed"]]));
    expect(closed.status).toBe(200);
    expect([await applicationBytes(b, lead.taskId), await applicationBytes(b, harbor.taskId)]).toEqual(before);
    const record = (await new SessionsStore(b.workspace, b.clock).list()).sessions[0]!;
    expect(record.items.map((item) => item.tab?.status)).toEqual(["closed", "closed"]);
    expect(record.flags.map((flag) => [flag.kind, flag.taskId])).toEqual([
      ["closed", lead.taskId],
      ["closed", harbor.taskId],
    ]);
  });

  it("moves Ready to Applied only on application_status_changed with applied at the current revision; deferred moves nothing", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    const harbor = await seedApplication(b.workspace, b.clock, postingFor("Platform Engineer", "Harbor"));
    await startSession(b, [lead.taskId, harbor.taskId]);
    const [command] = await leased(b, token);
    await postEvent(b, token, commandResult(command!.commandId, [[lead.taskId, "opened"], [harbor.taskId, "opened"]]));

    const deferred = await postEvent(b, token, statusChanged(harbor.taskId, harbor.application.revision, "deferred"));
    expect(deferred.status).toBe(200);
    expect((await application(b, harbor.taskId)).stage).toBe("ready");
    expect((await application(b, harbor.taskId)).revision).toBe(harbor.application.revision);

    const applied = await postEvent(b, token, statusChanged(lead.taskId, lead.application.revision));
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { result: unknown }).result).toEqual({ taskId: lead.taskId, outcome: "applied", stage: "applied", revision: lead.application.revision + 1 });
    expect(await application(b, lead.taskId)).toMatchObject({ stage: "applied", revision: lead.application.revision + 1 });
  });

  it("refuses a stale revision, never merging it", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    // Something else wrote the application since the browser saw it (a preparation, say).
    await new ApplicationsStore(b.workspace, b.clock).update(lead.taskId, (current) => ({ ...current, notes: "Fictional note." }));
    const before = await applicationBytes(b, lead.taskId);
    const stale = await postEvent(b, token, statusChanged(lead.taskId, lead.application.revision));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("stale_revision");
    expect(await applicationBytes(b, lead.taskId)).toBe(before);
  });

  it("never resets a stage the person moved past Applied", () => {
    const base: Application = { taskId: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", jobId: "2e4f6a8b-0c1d-4e3f-9a5b-7c9d1e3f5a7b", stage: "interviewing", revision: 4, documents: [], notes: "", deadlines: [], processing: { status: "idle" } };
    expect(decideStatusChange(base, { status: "applied", expectedRevision: 4 })).toMatchObject({ kind: "refused", code: "stage_moved_on" });
    expect(decideStatusChange({ ...base, stage: "applied" }, { status: "applied", expectedRevision: 4 })).toEqual({ kind: "record", outcome: "already_applied" });
    expect(decideStatusChange({ ...base, stage: "ready" }, { status: "applied", expectedRevision: 3 })).toMatchObject({ kind: "refused", code: "stale_revision" });
  });
});

describe("sessions: replaying any command or event has no second effect (acceptance)", () => {
  it("a replayed status change or result, through the bridge, changes nothing a second time", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await leased(b, token);
    const result = commandResult(command!.commandId, [[lead.taskId, "closed"]]);
    await postEvent(b, token, result);
    const change = statusChanged(lead.taskId, lead.application.revision);
    await postEvent(b, token, change);
    const after = await applicationBytes(b, lead.taskId);
    const record = JSON.stringify(await new SessionsStore(b.workspace, b.clock).read(command!.sessionId));
    for (const event of [result, change, result, change]) {
      const replay = await postEvent(b, token, event);
      expect(((await replay.json()) as { duplicate: boolean }).duplicate).toBe(true);
    }
    expect(await applicationBytes(b, lead.taskId)).toBe(after);
    expect(JSON.stringify(await new SessionsStore(b.workspace, b.clock).read(command!.sessionId))).toBe(record);
  });

  it("each handler is idempotent on its own: a dispatch run twice (a retry after a failure) records one result and one flag", async () => {
    const b = await bridge();
    const { deviceId, token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await leased(b, token);
    const device = (await b.ctx.devices.list()).find((entry) => entry.deviceId === deviceId)!;
    const event = commandResult(command!.commandId, [[lead.taskId, "closed"]]);
    const ctx = { ...b.ctx, device, receivedAt: b.clock.now() };
    await handleCommandResult(event, ctx);
    await handleCommandResult(event, ctx);
    const record = (await new SessionsStore(b.workspace, b.clock).read(command!.sessionId))!;
    expect(record.results).toHaveLength(1);
    expect(record.flags).toHaveLength(1);
  });

  it("a status change the runner stopped halfway through (recorded, not yet written) finishes once when retried", async () => {
    const b = await bridge();
    const { deviceId, token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await leased(b, token);
    const store = new SessionsStore(b.workspace, b.clock);
    const event = statusChanged(lead.taskId, lead.application.revision);
    // The runner stopped after writing the change's intent, before the application: the record holds it, unfinished.
    const record = (await store.read(command!.sessionId))!;
    await b.workspace.writeJson(["sessions", record.sessionId, "state.json"], { ...record, changes: [{ eventId: event.eventId, taskId: lead.taskId, status: "applied", expectedRevision: lead.application.revision, at: b.clock.now().toISOString(), source: "bridge" }] });
    const context = { commands: b.ctx.commands, receivedAt: b.clock.now(), deviceId, source: "bridge" as const };
    expect(await store.applyStatusChange(event, context)).toMatchObject({ kind: "applied", outcome: "applied", revision: lead.application.revision + 1 });
    expect(await store.applyStatusChange(event, context)).toMatchObject({ kind: "duplicate", outcome: "applied", revision: lead.application.revision + 1 });
    expect(await application(b, lead.taskId)).toMatchObject({ stage: "applied", revision: lead.application.revision + 1 });
  });

  it("an event imported from inbox/ that the bridge already delivered changes nothing, and a second import changes nothing either", async () => {
    const b = await bridge();
    const { token } = await pairDevice(b);
    const lead = await seedApplication(b.workspace, b.clock, platformLeadJob());
    await startSession(b, [lead.taskId]);
    const [command] = await leased(b, token);
    const result = commandResult(command!.commandId, [[lead.taskId, "opened"]]);
    const change = statusChanged(lead.taskId, lead.application.revision);
    await postEvent(b, token, result);
    await postEvent(b, token, change);
    const after = await applicationBytes(b, lead.taskId);
    await b.workspace.writeJson(["inbox", "results.json"], { events: [result, change] });
    const store = new SessionsStore(b.workspace, b.clock);
    for (let round = 0; round < 2; round += 1) {
      const imported = await store.importInbox("results.json", b.ctx.commands);
      expect(imported?.outcomes.map((entry) => entry.outcome)).toEqual(["already", "already"]);
    }
    expect(await applicationBytes(b, lead.taskId)).toBe(after);
  });
});
