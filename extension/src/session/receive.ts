/**
 * Taking sessions in (P07 part C): `GET /commands` when the side panel
 * opens and on the worker's 15-minute alarm, and a session manifest the
 * person imports from a file (the file bridge). Taking one in never opens a
 * tab: it is stored as "Ready to open in your browser" and waits for the
 * person's click (open.ts).
 *
 * - The bridge leases a command for 5 minutes and sends it again until
 *   this browser reports on it (P06). Every commandId taken in is
 *   remembered (`wcCommand:<id>`), so a command sent again is never taken
 *   in twice, and never opened twice.
 * - A session can reach this browser both ways (the runner's "Write to
 *   outbox" can write one that is also queued for it): sessions are
 *   deduplicated by sessionId. A file copy of a session already here
 *   changes nothing; a command for a session first imported from a file
 *   attaches to it, and if that session was already opened, reports what
 *   is open rather than opening it again.
 * - A command this browser won't act on (policy.ts) is kept as refused, so
 *   the side panel can say why. If it was addressed to this browser and
 *   hasn't expired, the refusal is reported (`failed`, every item
 *   `skipped`), which the runner flags for review and which stops it being
 *   sent again.
 */
import type { OpenApplicationGroup, SessionManifest } from "@workflow-catalog/contracts";
import type { BridgeClient, BridgeError } from "../shared/bridge-client";
import { getDeviceToken } from "../shared/storage";
import { checkCommand, checkItems, itemsRefusal, type CheckedItem } from "./policy";
import { buildReport, firstReportItems, flushAllSessions, hasFirstReport, withQueuedEvent } from "./report";
import { mutateSession, readSession, rememberCommand, sessionIdForCommand, type LocalSession, type SessionItem } from "./store";

export type PollOutcome =
  | { readonly kind: "not_paired" }
  | { readonly kind: "error"; readonly error: BridgeError }
  | { readonly kind: "ok"; readonly received: number; readonly refused: number };

/** The longest session title kept (the runner's own cap, MAX_SESSION_TITLE_LENGTH); a longer one is cut, never refused. */
export const MAX_TITLE_LENGTH = 80;

/** How many commands one poll takes in. The runner queues a handful; more than this is not the runner's
 * answer, and the rest wait (gate 7: oversized messages are handled safely, never stored wholesale). */
export const MAX_COMMANDS_PER_POLL = 20;

/** A session title as the panel and the tab group show it: one line, at most MAX_TITLE_LENGTH characters. */
export function sessionTitle(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const title = oneLine.length === 0 ? "Untitled session" : oneLine;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

function itemsFrom(checked: readonly CheckedItem[]): SessionItem[] {
  return checked.map((item) => ({ taskId: item.taskId, jobRevision: item.jobRevision, url: item.url, ...(item.urlProblem ? { urlProblem: item.urlProblem } : {}) }));
}

/** Takes one command in. Returns what it became, or undefined when it was already here. */
async function takeCommand(command: OpenApplicationGroup, deviceId: string, now: Date): Promise<"received" | "refused" | undefined> {
  if ((await sessionIdForCommand(command.commandId)) !== undefined) return undefined;
  const check = checkCommand(command, { deviceId, now });
  let outcome: "received" | "refused" | undefined;
  await mutateSession(command.sessionId, (existing, tabs) => {
    if (existing?.commandId !== undefined) return undefined; // the session already came with a command
    if (existing) {
      // First imported from a file: the command attaches to it, never a second copy.
      if (!check.ok) return undefined;
      outcome = "received";
      const attached: LocalSession = { ...existing, source: "bridge", commandId: command.commandId, deviceId: command.deviceId, expiresAt: command.expiresAt };
      if (existing.phase !== "open" || hasFirstReport(attached)) return { session: attached };
      return { session: withQueuedEvent(attached, buildReport(attached, firstReportItems(attached, tabs))) };
    }
    const base: LocalSession = {
      sessionId: command.sessionId,
      title: sessionTitle(command.payload.title),
      source: "bridge",
      commandId: command.commandId,
      deviceId: command.deviceId,
      expiresAt: command.expiresAt,
      receivedAt: now.toISOString(),
      phase: check.ok ? "waiting" : "refused",
      ...(check.ok ? {} : { refusal: check.refusal }),
      items: itemsFrom(check.items),
      events: [],
    };
    outcome = check.ok ? "received" : "refused";
    if (check.ok || check.refusal === "other_device" || check.refusal === "expired") return { session: base };
    // Addressed here and still live, but not one this browser will open: say so, so it isn't sent again.
    const report = buildReport(base, base.items.map((item) => ({ taskId: item.taskId, status: "skipped" as const })), "failed");
    return { session: withQueuedEvent(base, report) };
  });
  await rememberCommand(command.commandId, command.sessionId);
  return outcome;
}

/**
 * `GET /commands`, then stores each new command as a waiting (or refused)
 * session, then sends whatever is pending. Opens nothing.
 */
export async function pollCommands(client: BridgeClient, now: () => Date = () => new Date()): Promise<PollOutcome> {
  const token = await getDeviceToken();
  if (!token) return { kind: "not_paired" };
  const result = await client.getCommands();
  if (!result.ok) return { kind: "error", error: result.error };
  let received = 0;
  let refused = 0;
  for (const command of result.value.commands.slice(0, MAX_COMMANDS_PER_POLL)) {
    const outcome = await takeCommand(command, token.deviceId, now());
    if (outcome === "received") received += 1;
    if (outcome === "refused") refused += 1;
  }
  await flushAllSessions(client);
  return { kind: "ok", received, refused };
}

export type ImportOutcome =
  | { readonly kind: "added"; readonly session: LocalSession }
  | { readonly kind: "already_here"; readonly session: LocalSession }
  | { readonly kind: "refused"; readonly session: LocalSession };

/**
 * The file bridge: stores an imported `application-session.json` (already
 * validated as a `SessionManifest`, file-bridge/session-import.ts) as a
 * waiting session. The file is untrusted data: its URLs are checked like a
 * command's, and a session already here (by sessionId) is never replaced,
 * so importing an old copy can't undo anything.
 */
export async function importManifest(manifest: SessionManifest, now: Date = new Date()): Promise<ImportOutcome> {
  const items = checkItems(manifest.items);
  const refusal = itemsRefusal(items);
  let outcome: ImportOutcome | undefined;
  await mutateSession(manifest.sessionId, (existing) => {
    if (existing) {
      outcome = { kind: "already_here", session: existing };
      return undefined;
    }
    const session: LocalSession = {
      sessionId: manifest.sessionId,
      title: sessionTitle(manifest.title),
      source: "file",
      receivedAt: now.toISOString(),
      phase: refusal ? "refused" : "waiting",
      ...(refusal ? { refusal } : {}),
      items: itemsFrom(items),
      events: [],
    };
    outcome = refusal ? { kind: "refused", session } : { kind: "added", session };
    return { session };
  });
  return outcome ?? { kind: "already_here", session: (await readSession(manifest.sessionId))! };
}
