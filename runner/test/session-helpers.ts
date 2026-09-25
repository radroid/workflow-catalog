import { randomUUID } from "node:crypto";
import type { Application, ApplicationStage, ApplicationStatusChanged, BrowserCommandItemStatus, BrowserCommandResult } from "@workflow-catalog/contracts";
import type { Clock } from "../lib/clock.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import applicationsModule from "../server/routes/applications.ts";
import commandsModule from "../server/routes/commands.ts";
import runsModule from "../server/routes/runs.ts";
import sessionsModule from "../server/routes/sessions.ts";
import { ApplicationsStore, documentPath } from "../store/applications.ts";
import type { Workspace } from "../store/workspace.ts";
import { seedJob } from "./preparation-helpers.ts";

/** The P06 route modules, with the budget's (runs) for the board. Fictional data only. */
export const SESSION_MODULES: readonly LoadedRouteModule[] = [
  { name: "applications", module: applicationsModule },
  { name: "commands", module: commandsModule },
  { name: "runs", module: runsModule },
  { name: "sessions", module: sessionsModule },
];

export interface SeededApplication {
  readonly taskId: string;
  readonly jobId: string;
  readonly application: Application;
}

/**
 * An application with a saved job and one prepared version's documents, at `stage` (Ready by default), written
 * through the real stores. The document entries are what a preparation attaches; the files themselves aren't
 * needed by a session, which reads only the stage, the documents' job revision and the stored job URL.
 */
export async function seedApplication(
  workspace: Workspace,
  clock: Clock,
  job: { readonly url: string; readonly text: string; readonly structured: { readonly title?: string; readonly company?: string } },
  stage: ApplicationStage = "ready",
  options: { readonly documents?: boolean } = {},
): Promise<SeededApplication> {
  const { jobId, revision } = await seedJob(workspace, clock, job);
  const store = new ApplicationsStore(workspace, clock);
  const { application } = await store.ensureForJob(jobId);
  const createdAt = clock.now().toISOString();
  const documents =
    options.documents === false
      ? []
      : (["md", "docx", "pdf"] as const).map((format) => ({
          kind: "resume" as const,
          version: 1,
          format,
          path: documentPath(application.taskId, `resume-v1.${format}`),
          createdAt,
          profileVersion: 1,
          jobRevision: revision,
          idempotencyKey: `${jobId}@${revision}+profile@v1+resume+inputs@000000000000+details@000000000000`,
        }));
  const updated = await store.update(application.taskId, (current) => ({ ...current, stage, documents }));
  return { taskId: application.taskId, jobId, application: updated };
}

/** A fictional posting for session tests: its own title and company, at `jobs.example`. */
export function postingFor(title: string, company: string, url = `https://jobs.example/postings/${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`) {
  return { url, text: `${title} — ${company}\n\n${company} is hiring a ${title}. Fictional posting for tests.`, structured: { title, company, requirements: ["Fictional requirement"] } };
}

export function statusChanged(taskId: string, expectedRevision: number, status: "applied" | "deferred" = "applied", eventId = randomUUID()): ApplicationStatusChanged {
  return { protocol: 1, type: "application_status_changed", eventId, taskId, expectedRevision, status, occurredAt: "2026-09-22T09:30:00.000Z" };
}

export function commandResult(commandId: string, items: ReadonlyArray<readonly [string, BrowserCommandItemStatus]>, status: BrowserCommandResult["status"] = "completed", eventId = randomUUID()): BrowserCommandResult {
  return { protocol: 1, type: "browser_command_result", eventId, commandId, status, items: items.map(([taskId, itemStatus]) => ({ taskId, status: itemStatus })), occurredAt: "2026-09-22T09:10:00.000Z" };
}
