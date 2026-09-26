import { MAX_APPLICATION_GROUP_SIZE, uuidSchema } from "@workflow-catalog/contracts";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { systemClock } from "../../lib/clock.ts";
import { CommandQueue } from "../../store/commands.ts";
import { SessionsStore } from "../../store/sessions.ts";
import { Workspace } from "../../store/workspace.ts";

// The one model-callable action (packages/job-assistant/adapters/eve/README.md). P06 owns the body.
//
// - Input is task IDs only, never a URL. Each ID resolves to the job URL the runner already stored for the
//   revision its documents were prepared from (store/sessions.ts), so nothing a hostile posting says can become
//   a navigation target. `.strict()` rejects any extra field.
// - approval: always(): the person approves every single call, never once() or auto(). Omitting `approval`
//   would mean never().
// - It runs inside eve's process, with no bridge context: it makes the session through the workspace files
//   (`RUNNER_WORKSPACE`, set by the launcher), exactly as the board does. The command goes to the most recently
//   paired browser; with none, the manifest goes to outbox/ for the extension's file import. It only ever
//   creates new files.
// - No directives: a plain `defineTool`, so the eval agent's one-line re-export stays the real tool
//   (docs/spec/research/eve-runtime.md §8 item 14 is about "use workflow"/"use step" modules).
export const openApplicationGroupInputSchema = z
  .object({
    taskIds: z.array(uuidSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
  })
  .strict();

export type OpenApplicationGroupOutput =
  | { readonly status: "queued"; readonly sessionId: string; readonly applications: number; readonly delivery: "browser" | "outbox"; readonly message: string }
  | { readonly status: "refused"; readonly code: string; readonly message: string };

const REFUSED_WORDS: Readonly<Record<string, string>> = {
  not_ready: "Only Ready applications can be opened.",
  no_documents: "An application has no prepared documents yet.",
  application_not_found: "One of those task IDs isn't an application in the workspace.",
  job_unreadable: "An application's saved posting can't be read.",
  url_not_allowed: "An application's saved address isn't a public https address.",
  already_waiting: "An application is already waiting to open in another session.",
  duplicate_task: "A task ID was given twice.",
};

/** Makes the session for `taskIds` in the workspace at `dir`. Exported for the tool's tests. */
export async function openApplicationGroup(taskIds: readonly string[], dir = process.env.RUNNER_WORKSPACE): Promise<OpenApplicationGroupOutput> {
  if (!dir) throw new Error("RUNNER_WORKSPACE is not set; the runner launcher sets it before the agent starts.");
  const workspace = await Workspace.open(dir);
  const created = await new SessionsStore(workspace, systemClock).create({ taskIds }, new CommandQueue(workspace, systemClock));
  if (!created.ok) return { status: "refused", code: created.code, message: `Nothing was opened. ${REFUSED_WORDS[created.code] ?? "The session couldn't be made."}` };
  const delivery = created.command ? "browser" : "outbox";
  return {
    status: "queued",
    sessionId: created.record.sessionId,
    applications: created.record.items.length,
    delivery,
    message:
      delivery === "browser"
        ? "The session is waiting for the paired browser. It opens there when the person starts it from the extension."
        : "No browser is paired, so the session was written to outbox/application-session.json for the extension to import.",
  };
}

export default defineTool({
  description:
    "Ask the paired Chrome extension to open one tab group for applications that are ready, identified by their task IDs. The person approves every call before anything opens.",
  inputSchema: openApplicationGroupInputSchema,
  approval: always(),
  async execute({ taskIds }) {
    return openApplicationGroup(taskIds);
  },
});
