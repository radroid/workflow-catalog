import { readFile } from "node:fs/promises";
import type { Application, ApplicationStage, ApplicationStatusChanged, BrowserCommandItemStatus, BrowserCommandResult } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import { ApplicationsStore, applicationPath } from "../store/applications.ts";
import { SessionsStore } from "../store/sessions.ts";
import { BRIDGE, makeBridge, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";
import { platformLeadJob } from "./preparation-helpers.ts";
import { commandResult, postingFor, seedApplication, SESSION_MODULES, statusChanged } from "./session-helpers.ts";

/**
 * P06 acceptance: "Importing an older manifest never resets a newer status", as a property over random event
 * orders. Each seed makes one session of two Ready applications for a paired browser, then runs a random
 * sequence of what can happen to it: the person's explicit status from the side panel (fresh, or at a revision
 * that is already stale), the browser's tab reports (closed included), a replay of any earlier event, a move on
 * the board, and imports from inbox/ of an older export (earlier events) or a session manifest (the current one,
 * or an older copy). After every step it checks:
 *
 *   1. no application's revision ever goes down;
 *   2. a stage moves only on an explicit Applied at the revision it names, or a board move;
 *   3. once past Ready, only a board move changes a stage;
 *   4. an import (manifest or older events), a replay and a tab report never change an application file.
 *
 * No new dependency: the random orders come from a small seeded generator (mulberry32), and every failure names
 * its seed and step, so it replays exactly.
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const SEEDS = 48;
const STEPS = 14;
/** Seeds run this many at a time, each in its own workspace (the stores serialise per workspace, never across). */
const PARALLEL = 8;
const PAST_READY: ReadonlySet<ApplicationStage> = new Set(["applied", "interviewing", "offer", "rejected", "withdrawn"]);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Event = ApplicationStatusChanged | BrowserCommandResult;
type Op = "status" | "stale_status" | "result" | "replay" | "import_events" | "import_manifest" | "move";
const OPS: readonly Op[] = ["status", "stale_status", "result", "replay", "import_events", "import_manifest", "move"];

async function run(seed: number): Promise<void> {
  const random = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const b: TestBridge = await makeBridge({ modules: SESSION_MODULES });
  const { token } = await pairDevice(b);
  const apps = [await seedApplication(b.workspace, b.clock, platformLeadJob()), await seedApplication(b.workspace, b.clock, postingFor("Platform Engineer", "Harbor"))];
  const taskIds = apps.map((app) => app.taskId);
  const started = await b.request("/api/sessions", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ taskIds }) });
  const { sessionId } = (await started.json()) as { sessionId: string };
  const commandId = (await b.ctx.commands.list())[0]!.command.commandId;
  const manifest = await b.workspace.readJson("sessions", `${sessionId}.json`);
  const store = new ApplicationsStore(b.workspace, b.clock);
  const sent: Event[] = [];
  let files = 0;

  const read = async () => {
    const out = new Map<string, { app: Application; bytes: string }>();
    for (const taskId of taskIds) out.set(taskId, { app: (await store.get(taskId))!, bytes: await readFile(await b.workspace.resolveReal(...applicationPath(taskId).split("/")), "utf8") });
    return out;
  };
  const importFile = async (content: unknown) => {
    files += 1;
    const name = `export-${files}.json`;
    await b.workspace.writeJson(["inbox", name], content);
    const response = await b.request("/api/sessions/inbox/import", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ name }) });
    expect(response.status, `seed ${seed}: import ${name}`).toBe(200);
  };

  for (let step = 0; step < STEPS; step += 1) {
    const where = `seed ${seed}, step ${step}`;
    const before = await read();
    const op = pick(OPS);
    const taskId = pick(taskIds);
    let acceptedApplied: { taskId: string; expected: number } | undefined;
    let moved: string | undefined;

    if (op === "status" || op === "stale_status") {
      const revision = before.get(taskId)!.app.revision; // at least 2: seeding writes the record twice
      const event = statusChanged(taskId, op === "stale_status" ? Math.max(1, revision - 1 - Math.floor(random() * 2)) : revision, random() < 0.7 ? "applied" : "deferred");
      const response = await postEvent(b, token, event);
      sent.push(event);
      if (response.status === 200 && event.status === "applied" && event.expectedRevision === revision) acceptedApplied = { taskId, expected: revision };
    } else if (op === "result") {
      const statuses: BrowserCommandItemStatus[] = ["opened", "closed", "failed", "skipped"];
      const event = commandResult(commandId, taskIds.filter(() => random() < 0.8).map((id) => [id, pick(statuses)] as const), pick(["completed", "partial", "failed"] as const));
      if (event.items.length === 0) event.items.push({ taskId, status: "closed" });
      await postEvent(b, token, event);
      sent.push(event);
    } else if (op === "replay") {
      if (sent.length > 0) await postEvent(b, token, pick(sent));
    } else if (op === "import_events") {
      // An older export: a random handful of earlier events, in a random order.
      const chosen = sent.filter(() => random() < 0.5).sort(() => random() - 0.5);
      if (chosen.length > 0) await importFile({ events: chosen });
    } else if (op === "import_manifest") {
      // The session's manifest, or an older copy of it naming fewer items: a manifest never carries a status.
      const older = { ...(manifest as Record<string, unknown>), items: ((manifest as { items: unknown[] }).items).slice(0, 1), createdAt: "2026-09-21T09:00:00.000Z" };
      await importFile(random() < 0.5 ? manifest : older);
    } else {
      const stage = pick(["saved", "ready", "applied", "interviewing", "offer", "rejected", "withdrawn"] as const);
      const response = await b.request(`/api/applications/${taskId}/stage`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ stage, expectedRevision: before.get(taskId)!.app.revision }) });
      expect(response.status, where).toBe(200);
      moved = taskId;
    }

    const after = await read();
    for (const id of taskIds) {
      const was = before.get(id)!;
      const now = after.get(id)!;
      const label = `${where} (${op}), task ${taskIds.indexOf(id)}`;
      expect(now.app.revision, `${label}: the revision went down`).toBeGreaterThanOrEqual(was.app.revision);
      if (now.app.stage !== was.app.stage) {
        const explicit = moved === id || (acceptedApplied?.taskId === id && now.app.stage === "applied" && !PAST_READY.has(was.app.stage));
        expect(explicit, `${label}: ${was.app.stage} became ${now.app.stage} without the person's explicit status`).toBe(true);
      }
      if (PAST_READY.has(was.app.stage) && moved !== id) expect(now.app.stage, `${label}: a newer status was reset`).toBe(was.app.stage);
      if (op === "import_events" || op === "import_manifest" || op === "replay" || op === "result" || op === "stale_status") {
        expect(now.bytes, `${label}: the application file changed`).toBe(was.bytes);
      }
    }
    if (op === "import_manifest") {
      const record = await new SessionsStore(b.workspace, b.clock).read(sessionId);
      expect(record?.items.map((item) => item.taskId), where).toEqual(taskIds);
    }
  }
}

describe("sessions: importing an older manifest never resets a newer status (property over random event orders)", () => {
  it(`holds for ${SEEDS} seeded random orders of ${STEPS} steps`, async () => {
    for (let first = 1; first <= SEEDS; first += PARALLEL) {
      const seeds = Array.from({ length: Math.min(PARALLEL, SEEDS - first + 1) }, (_, index) => first + index);
      await Promise.all(
        seeds.map(async (seed) => {
          try {
            await run(seed);
          } catch (error) {
            throw new Error(`Failed at seed ${seed} (rerun run(${seed}) to replay it): ${(error as Error).message}`, { cause: error });
          }
        }),
      );
    }
  }, 300_000);
});
