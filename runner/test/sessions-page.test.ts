import { describe, expect, it } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { BRIDGE, makeBridge, pairDevice, postEvent, UI_TOKEN, type TestBridge } from "./helpers.ts";
import { openUiPage, until, UUID, type Page } from "./page-harness.ts";
import { platformLeadJob } from "./preparation-helpers.ts";
import { commandResult, postingFor, seedApplication, SESSION_MODULES, statusChanged } from "./session-helpers.ts";

/**
 * The Sessions page (P06, mvp-spec F9), its own script run in a DOM against the real routes: each session with
 * what the browser said per tab and the person's choices; the results flagged for review, which moved nothing;
 * and the file bridge's reconciliation view (outbox/, inbox/, "Changes not yet synced", Import). Fictional data
 * only (Ada Quill; Fernwood, Harbor).
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function start(bridge: TestBridge, taskIds: readonly string[]): Promise<string> {
  const response = await bridge.request("/api/sessions", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ taskIds }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

function openSessions(bridge: TestBridge): Promise<Page> {
  return openUiPage(bridge, { page: "sessions", ready: (document) => (document.getElementById("sync-line")?.textContent ?? "Loading…") !== "Loading…" });
}

describe("the Sessions page: a session and a flagged result", () => {
  it("shows each tab's report and the person's choice; a closed tab is flagged for review and moved nothing; Mark as reviewed clears it", async () => {
    const bridge = await makeBridge({ modules: SESSION_MODULES });
    const { token } = await pairDevice(bridge);
    const lead = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const harbor = await seedApplication(bridge.workspace, bridge.clock, postingFor("Platform Engineer", "Harbor"));
    const sessionId = await start(bridge, [lead.taskId, harbor.taskId]);
    const commandId = (await bridge.ctx.commands.list())[0]!.command.commandId;
    expect((await postEvent(bridge, token, commandResult(commandId, [[lead.taskId, "opened"], [harbor.taskId, "closed"]]))).status).toBe(200);
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    expect((await postEvent(bridge, token, statusChanged(lead.taskId, (await store.get(lead.taskId))!.revision, "applied"))).status).toBe(200);

    const page = await openSessions(bridge);
    const session = page.byId(`session-${sessionId}`);
    expect(session.querySelector("h3")?.textContent).toBe("“Apply today”");
    expect(session.querySelector(".delivery")?.textContent).toBe("Your browser reported on it.");
    expect(page.byId(`item-${lead.taskId}`).textContent).toBe("“Platform Lead · Fernwood” · Applied · tab opened · you chose Applied");
    expect(page.byId(`item-${harbor.taskId}`).textContent).toBe("“Platform Engineer · Harbor” · Ready · tab closed");

    // The closed tab: flagged for the person, and its stage unmoved.
    expect((await store.get(harbor.taskId))!.stage).toBe("ready");
    const flags = page.all(".review-item");
    expect(flags).toHaveLength(1);
    expect(flags[0]!.querySelector(".review-text")?.textContent).toBe("“Platform Engineer · Harbor”'s tab was closed without Applied or Defer. Nothing changed; if you applied, move it on the Board.");
    expect(flags[0]!.querySelector(".review-text a")?.getAttribute("href")).toBe("/ui/board");
    expect(page.visibleText()).not.toMatch(UUID);

    const reviewId = flags[0]!.id.replace("flag-", "review-");
    page.press(reviewId);
    await until(() => page.outcomes().length > 0, "the review");
    expect(page.outcomes()).toEqual(["Reviewed “Platform Engineer · Harbor”'s result."]);
    expect(page.all(".review-item")).toHaveLength(0);
    expect(page.byId("review-none").textContent).toBe("Nothing needs your review.");
    // The item it acted on left the page, so focus went to the section's heading, never to the page.
    expect(page.document.activeElement?.id).toBe("review-title");
    expect((await store.get(harbor.taskId))!.stage).toBe("ready");
  });
});

describe("the Sessions page: the reconciliation view (file bridge)", () => {
  it("shows the outbox and an unsynced inbox export, and importing it applies the person's choice once; the file then reads as synced", async () => {
    const bridge = await makeBridge({ modules: SESSION_MODULES });
    const lead = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const sessionId = await start(bridge, [lead.taskId]); // no browser paired: it goes to outbox/
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    await bridge.workspace.writeJson(["inbox", "export-1.json"], { events: [statusChanged(lead.taskId, (await store.get(lead.taskId))!.revision, "applied")] });

    const page = await openSessions(bridge);
    expect(page.byId(`session-${sessionId}`).querySelector(".delivery")?.textContent).toMatch(/^No browser was paired, so it went to outbox\/application-session\.json \(.+\) for the extension to import\.$/);
    expect(page.byId("outbox-line").textContent).toMatch(/^outbox\/application-session\.json holds “Apply today” \(1 application, started .+\)\.$/);
    const sync = page.byId("sync-line");
    expect(sync.textContent).toBe("Changes not yet synced: 1 change in inbox/ hasn't been imported.");
    expect(sync.className).toContain("waiting");
    expect(sync.querySelector("code")?.textContent).toBe("inbox/");
    const file = page.byId("inbox-0");
    expect(file.querySelector("code")?.textContent).toBe("inbox/export-1.json");
    expect(file.querySelector(".event")?.textContent).toBe("Applied: “Platform Lead · Fernwood” — will be imported.");
    expect(page.visibleText()).not.toMatch(UUID);

    page.press("import-0");
    await until(() => page.outcomes().length > 0, "the import");
    expect(page.outcomes()).toEqual(["Imported “export-1.json”: 1 imported."]);
    expect((await store.get(lead.taskId))!.stage).toBe("applied");
    expect(page.byId("sync-line").textContent).toBe("Everything in inbox/ is imported: nothing waits to be synced.");
    expect(page.document.getElementById("import-0")).toBeNull();
    expect(page.byId("inbox-0").querySelector(".event")?.textContent).toBe("Applied: “Platform Lead · Fernwood” — already in the workspace.");
    expect(page.document.activeElement?.id).toBe("files-title");
    const revision = (await store.get(lead.taskId))!.revision;

    // A later refresh changes nothing: the file is imported once.
    page.refreshNow();
    await page.quiet();
    expect((await store.get(lead.taskId))!.revision).toBe(revision);
    expect(page.outcomes()).toHaveLength(1);
  });

  it("with nothing yet, says what each part is for", async () => {
    const bridge = await makeBridge({ modules: SESSION_MODULES });
    const page = await openSessions(bridge);
    expect(page.byId("sessions-none").textContent).toBe("No sessions yet. Choose Ready applications on the Board and start one.");
    expect(page.byId("review-none").textContent).toBe("Nothing needs your review.");
    expect(page.byId("outbox-line").textContent).toBe("outbox/application-session.json is empty. A session goes there when no browser is paired, or when you write it there.");
    expect(page.byId("inbox-none").textContent).toBe("inbox/ is empty. Put a results file the extension exported there, then import it here.");
    expect(page.byId("sync-line").textContent).toBe("Everything in inbox/ is imported: nothing waits to be synced.");
  });
});
