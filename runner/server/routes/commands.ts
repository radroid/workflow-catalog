import type { BrowserCommandResult } from "@workflow-catalog/contracts";
import { SessionsStore } from "../../store/sessions.ts";
import { defineRouteModule, EventRejectedError, type EventContext } from "../route-modules.ts";

/**
 * The browser's report on an `open_application_group` command (P06): `browser_command_result` on
 * `POST /events`. `GET /commands` itself is P02's (`server/extension-api.ts` over `store/commands.ts`); this
 * module retires a command once the browser reports on it (`ctx.commands.acknowledge()`), and records what it
 * said per item on the session (`store/sessions.ts`):
 *
 * - A result for another browser's command is refused (403), and so is a first report after the command
 *   expired (410), or one for a command the runner never sent (404).
 * - Each tab's status is recorded on its item. None of them, `closed` included, moves a stage.
 * - A failed, skipped, missing, unknown or conflicting item, and a partial or failed result, is flagged for
 *   review on the Sessions page, never guessed.
 * - The same eventId applies once, however often the dispatch runs (a retry after a failure, or the same
 *   event imported from `inbox/`).
 *
 * The result sent back names each of the command's applications with its stage and revision now: that is how
 * the extension learns the `expectedRevision` its `application_status_changed` must carry.
 */
export async function handleCommandResult(event: BrowserCommandResult, ctx: EventContext) {
  const outcome = await new SessionsStore(ctx.workspace, ctx.clock).applyCommandResult(event, {
    commands: ctx.commands,
    receivedAt: ctx.receivedAt,
    deviceId: ctx.device.deviceId,
    source: "bridge",
  });
  if (outcome.kind === "refused") throw new EventRejectedError(outcome.status, outcome.code, outcome.message);
  if (outcome.flagged > 0) ctx.log.info(`sessions: a browser report on session ${outcome.sessionId} needs review (${outcome.flagged}).`);
  return { sessionId: outcome.sessionId, items: outcome.items, flagged: outcome.flagged };
}

export default defineRouteModule({
  events: {
    browser_command_result: handleCommandResult,
  },
});
