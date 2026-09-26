import { uuidSchema, type ApplicationStatusChanged } from "@workflow-catalog/contracts";
import { z } from "zod";
import { ApplicationsStore } from "../../store/applications.ts";
import type { CommandRecord } from "../../store/commands.ts";
import { JobsStore } from "../../store/jobs.ts";
import {
  MAX_SESSION_TITLE_LENGTH,
  SessionsStore,
  type CreateSessionResult,
  type InboxFile,
  type SessionRecord,
} from "../../store/sessions.ts";
import type { RunnerContext } from "../context.ts";
import { errorResponse, jsonResponse, readBoundedJson, validationErrorResponse } from "../http.ts";
import { defineRouteModule, EventRejectedError, type EventContext } from "../route-modules.ts";
import { jobName } from "./applications.ts";

/**
 * Application sessions (P06, mvp-spec F9), mounted at `/api/sessions`, and the person's explicit status from
 * the extension (`application_status_changed` on `POST /events`).
 *
 *   GET  /api/sessions                         every session (manifest items, the command's state, each tab's
 *                                              report, the person's choices, what needs review), the paired
 *                                              browser, and the file bridge: outbox/ and inbox/
 *   POST /api/sessions                         { taskIds, title? }: a session from Ready applications
 *   POST /api/sessions/:id/outbox              writes its manifest to outbox/application-session.json
 *   POST /api/sessions/:id/flags/:flagId/review   marks a flagged result as reviewed
 *   POST /api/sessions/inbox/import            { name }: imports one inbox/ file the person chose
 *
 * Only the person's explicit choice moves a stage (`applied`, at the revision the browser last saw; a stale one
 * is refused, never merged); the rules live in `store/sessions.ts`. The event's result names the application's
 * stage and revision now, for the extension's next status.
 */

const MAX_CREATE_BODY_BYTES = 8 * 1024;
const MAX_IMPORT_BODY_BYTES = 1024;

const createBodySchema = z.object({ taskIds: z.array(z.string()).max(100), title: z.string().max(400).optional() }).strict();
const importBodySchema = z.object({ name: z.string().min(1).max(200) }).strict();

function store(ctx: RunnerContext): SessionsStore {
  return new SessionsStore(ctx.workspace, ctx.clock);
}

/** The first eight characters of an id, for the rare line that must show one; the full value goes in a title attribute. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

async function namesFor(ctx: RunnerContext, taskIds: Iterable<string>): Promise<Map<string, { readonly jobName: string; readonly stage: string | null }>> {
  const applications = new ApplicationsStore(ctx.workspace, ctx.clock);
  const jobs = new JobsStore(ctx.workspace);
  const names = new Map<string, { jobName: string; stage: string | null }>();
  for (const taskId of new Set(taskIds)) {
    const application = await applications.get(taskId);
    if (!application) {
      names.set(taskId, { jobName: "An application that isn't in the workspace", stage: null });
      continue;
    }
    const revisions = await jobs.revisions(application.jobId);
    let snapshot;
    for (let index = revisions.length - 1; index >= 0 && !snapshot; index -= 1) snapshot = await jobs.getSnapshot(application.jobId, revisions[index]!);
    names.set(taskId, { jobName: jobName(snapshot), stage: application.stage });
  }
  return names;
}

type DeliveryState = "file" | "missing" | "waiting" | "delivered" | "reported" | "expired" | "expired_taken";

function deliveryOf(record: SessionRecord, command: CommandRecord | undefined, now: Date): DeliveryState {
  if (!record.commandId) return "file";
  if (!command) return "missing";
  if (command.acknowledgedAt) return "reported";
  if (new Date(command.command.expiresAt).getTime() <= now.getTime()) return command.deliveries > 0 ? "expired_taken" : "expired";
  return command.deliveries > 0 ? "delivered" : "waiting";
}

function inboxFileView(file: InboxFile, names: Map<string, { readonly jobName: string }>) {
  return {
    name: file.name,
    kind: file.kind,
    bytes: file.bytes,
    importedAt: file.importedAt ?? null,
    skipped: file.skipped,
    session: file.session ? { known: file.session.known, title: file.session.title } : null,
    events: file.events.map((event) => ({
      type: event.type,
      plan: event.plan,
      code: "code" in event ? (event.code ?? null) : null,
      status: "status" in event ? (event.status ?? null) : null,
      jobNames: event.taskIds.map((taskId) => names.get(taskId)?.jobName ?? "An application that isn't in the workspace"),
    })),
  };
}

async function sessionsView(ctx: RunnerContext) {
  const sessions = store(ctx);
  const now = ctx.clock.now();
  const { sessions: records, unreadable } = await sessions.list();
  const inbox = await sessions.inbox(ctx.commands);
  const outbox = await sessions.readOutbox();
  const taskIds = [...records.flatMap((record) => [...record.items.map((item) => item.taskId), ...record.flags.flatMap((flag) => (flag.taskId ? [flag.taskId] : []))]), ...inbox.files.flatMap((file) => file.events.flatMap((event) => event.taskIds))];
  const names = await namesFor(ctx, taskIds);
  const devices = await ctx.devices.active();
  const views = [];
  let review = 0;
  for (const record of records) {
    const command = record.commandId ? await ctx.commands.get(record.commandId) : undefined;
    const delivery = deliveryOf(record, command, now);
    const inCommand = new Set(record.items.map((item) => item.taskId));
    const flags = record.flags.map((flag) => ({
      flagId: flag.flagId,
      kind: flag.kind,
      // A task the browser named that isn't in this session is never named back: it isn't this session's.
      jobName: flag.taskId && inCommand.has(flag.taskId) ? (names.get(flag.taskId)?.jobName ?? null) : null,
      at: flag.at,
      reviewed: flag.reviewedAt !== undefined,
    }));
    review += flags.filter((flag) => !flag.reviewed).length;
    views.push({
      sessionId: record.sessionId,
      shortId: shortId(record.sessionId),
      title: record.title,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      delivery,
      deliveredTimes: command?.deliveries ?? 0,
      reported: record.results.length > 0,
      outboxAt: record.outboxAt ?? null,
      items: record.items.map((item) => ({
        taskId: item.taskId,
        jobName: names.get(item.taskId)?.jobName ?? "An application that isn't in the workspace",
        stage: names.get(item.taskId)?.stage ?? null,
        tab: item.tab?.status ?? null,
        choice: item.choice?.status ?? null,
      })),
      flags,
    });
  }
  const outboxManifest = outbox.manifest;
  return {
    device: devices.length > 0 ? { paired: true, pairedAt: devices.at(-1)!.pairedAt, count: devices.length } : { paired: false, pairedAt: null, count: 0 },
    sessions: views,
    unreadable: unreadable.map((path) => ({ path })),
    review,
    outbox: {
      present: outbox.present,
      readable: outbox.readable,
      session: outboxManifest ? { title: outboxManifest.title, createdAt: outboxManifest.createdAt, known: records.some((record) => record.sessionId === outboxManifest.sessionId), items: outboxManifest.items.length } : null,
    },
    inbox: { files: inbox.files.map((file) => inboxFileView(file, names)), more: inbox.more },
    unsynced: inbox.files.reduce((sum, file) => sum + file.events.filter((event) => event.plan === "apply").length, 0),
  };
}

const REFUSALS: Readonly<Record<Exclude<CreateSessionResult, { ok: true }>["code"], { readonly status: 400 | 404 | 409; readonly message: (name: string) => string }>> = {
  no_tasks: { status: 400, message: () => "Choose at least one Ready application first." },
  too_many: { status: 400, message: () => "A session opens at most 20 applications at once. Choose fewer." },
  duplicate_task: { status: 400, message: () => "One application was chosen twice. Choose each once." },
  bad_title: { status: 400, message: () => `Give the session a name of at most ${MAX_SESSION_TITLE_LENGTH} characters.` },
  application_not_found: { status: 404, message: () => "One of those applications isn't in the workspace any more. Refresh the board." },
  not_ready: { status: 409, message: (name) => `“${name}” isn't Ready, so it can't go in a session.` },
  no_documents: { status: 409, message: (name) => `“${name}” has no prepared documents yet.` },
  job_unreadable: { status: 409, message: (name) => `“${name}”'s saved posting can't be read, so its address isn't known.` },
  url_not_allowed: { status: 409, message: (name) => `“${name}”'s saved address isn't a public https address, so the browser won't be asked to open it. Open it yourself.` },
  already_waiting: { status: 409, message: (name) => `“${name}” is already waiting to open in another session.` },
};

async function handleStatusChanged(event: ApplicationStatusChanged, ctx: EventContext) {
  const outcome = await store(ctx).applyStatusChange(event, { commands: ctx.commands, receivedAt: ctx.receivedAt, deviceId: ctx.device.deviceId, source: "bridge" });
  if (outcome.kind === "refused") throw new EventRejectedError(outcome.status, outcome.code, outcome.message);
  return { taskId: outcome.taskId, outcome: outcome.outcome, stage: outcome.stage, revision: outcome.revision };
}

export default defineRouteModule({
  events: {
    application_status_changed: handleStatusChanged,
  },

  api(router, ctx) {
    router.get("/", async (c) => c.json(await sessionsView(ctx)));

    router.post("/", async (c) => {
      const body = await readBoundedJson(c.req.raw, MAX_CREATE_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = createBodySchema.safeParse(body.value);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const created = await store(ctx).create({ taskIds: parsed.data.taskIds, ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}) }, ctx.commands);
      if (!created.ok) {
        const refusal = REFUSALS[created.code];
        const name = created.taskId ? ((await namesFor(ctx, [created.taskId])).get(created.taskId)?.jobName ?? "That application") : "That application";
        // The task at fault goes with the refusal, so the board names it in its own words.
        return jsonResponse(refusal.status, { ok: false, error: { code: created.code, message: refusal.message(name), ...(created.taskId ? { taskId: created.taskId } : {}) } });
      }
      ctx.log.info(`sessions: started session ${created.record.sessionId} (${created.record.items.length} item(s), ${created.command ? "sent to the paired browser" : "written to outbox/"}).`);
      const view = await sessionsView(ctx);
      return c.json({ ok: true, sessionId: created.record.sessionId, sent: created.command !== undefined, session: view.sessions.find((session) => session.sessionId === created.record.sessionId) ?? null, view });
    });

    router.post("/inbox/import", async (c) => {
      const body = await readBoundedJson(c.req.raw, MAX_IMPORT_BODY_BYTES);
      if (!body.ok) return body.response;
      const parsed = importBodySchema.safeParse(body.value);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const imported = await store(ctx).importInbox(parsed.data.name, ctx.commands);
      if (!imported) return errorResponse(404, "not_found", "That file isn't in inbox/ any more.");
      const applied = imported.outcomes.filter((entry) => entry.outcome === "applied").length;
      const already = imported.outcomes.filter((entry) => entry.outcome === "already").length;
      const refused = imported.outcomes.filter((entry) => entry.outcome.startsWith("refused:")).length;
      return c.json({ ok: true, kind: imported.file.kind, applied, already, refused, view: await sessionsView(ctx) });
    });

    router.post("/:sessionId/outbox", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!uuidSchema.safeParse(sessionId).success) return errorResponse(404, "not_found", "No such session.");
      const record = await store(ctx).writeOutbox(sessionId);
      if (!record) return errorResponse(404, "not_found", "No such session.");
      return c.json({ ok: true, view: await sessionsView(ctx) });
    });

    router.post("/:sessionId/flags/:flagId/review", async (c) => {
      const sessionId = c.req.param("sessionId");
      const flagId = c.req.param("flagId");
      if (!uuidSchema.safeParse(sessionId).success || !uuidSchema.safeParse(flagId).success) return errorResponse(404, "not_found", "No such result.");
      const record = await store(ctx).reviewFlag(sessionId, flagId);
      if (!record) return errorResponse(404, "not_found", "No such result.");
      return c.json({ ok: true, view: await sessionsView(ctx) });
    });
  },
});
