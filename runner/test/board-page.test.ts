import { openApplicationGroupSchema } from "@workflow-catalog/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPreparationQueue } from "../server/routes/applications.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { pauseBudget } from "../store/budget.ts";
import { BRIDGE, makeBridge, pairDevice, UI_TOKEN, type TestBridge } from "./helpers.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { openUiPage, until, UUID, type Page } from "./page-harness.ts";
import { fixtureJob, HARBOR_JOB, HOSTILE_JOB, platformLeadJob, scriptedModel, seedDetails, seedJob, seedReadyProfile, type Planner } from "./preparation-helpers.ts";
import { postingFor, seedApplication, SESSION_MODULES } from "./session-helpers.ts";

/**
 * The board (P06, mvp-spec F8), its own script run in a DOM against the real routes: every application in its
 * stage's column, the last preparation's outcome shown apart from the stage, the run budget and its pause,
 * starting a session from Ready applications, and moving a card. The house rules it holds to: one live region;
 * focus never dropped; amber only for a decision (a preparation waiting on the person's answer); and no id in
 * visible text. Fictional data only (Ada Quill; Fernwood, Harbor, Quill, Northwind Labs).
 */

const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const bridges: TestBridge[] = [];

afterEach(async () => {
  while (bridges.length > 0) await waitForPreparationQueue(bridges.pop()!.workspace.root);
});

/** Harbor's turn fails; Quill's asks two questions and parks; anything else isn't prepared in these tests. */
const planner: Planner = (prompt) =>
  prompt.company === "Harbor"
    ? { skills: ["claim-matching"], end: "failed" }
    : {
        skills: ["claim-matching"],
        calls: [
          {
            requirements: prompt.requirements.map((_text, index) =>
              index < 2 ? { requirement: index + 1, status: "gap" as const, question: `Which of your work shows requirement ${index + 1}?` } : { requirement: index + 1, status: "not_a_requirement" as const },
            ),
          },
        ],
      };

/** A bridge with the P06 routes; with `prepare`, also a ready profile and the scripted model, so preparations run. */
async function boardBridge({ prepare = false } = {}): Promise<TestBridge> {
  const holder: { bridge?: TestBridge } = {};
  const model = scriptedModel(() => ({ workspace: holder.bridge!.workspace, clock: holder.bridge!.clock }), planner);
  const bridge = await makeBridge({ modules: SESSION_MODULES, eve: model.eve });
  holder.bridge = bridge;
  bridges.push(bridge);
  if (prepare) {
    await seedReadyProfile(bridge.workspace, bridge.clock);
    await seedDetails(bridge.workspace, bridge.clock);
  }
  return bridge;
}

/** Prepares `jobId` through the API and waits for it to settle; returns its application's task ID. */
async function prepared(bridge: TestBridge, jobId: string): Promise<string> {
  const response = await bridge.request("/api/applications/prepare", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ jobId, coverLetter: false }) });
  expect(response.status).toBe(200);
  const { application } = (await response.json()) as { application: { taskId: string } };
  await waitForPreparationQueue(bridge.workspace.root);
  return application.taskId;
}

function openBoard(bridge: TestBridge): Promise<Page> {
  return openUiPage(bridge, { page: "board", ready: (document) => !(document.getElementById("board")?.textContent ?? "Loading…").includes("Loading…") });
}

function column(page: Page, stage: string): string[] {
  return page.all(`#stage-${stage} .board-card`).map((card) => card.id.replace("card-", ""));
}

function choose(page: Page, taskId: string): void {
  const box = page.byId(`pick-${taskId}`);
  box.checked = true;
  box.dispatchEvent(new page.window.Event("change", { bubbles: true }));
}

describe("the board renders the fixture set (acceptance)", () => {
  it("each application in its stage's column; a failed preparation shows in its processing line while the stage stays Saved; one waiting on answers says so in amber; no id in visible text", async () => {
    const bridge = await boardBridge({ prepare: true });
    const ready = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const applied = await seedApplication(bridge.workspace, bridge.clock, postingFor("Staff Engineer", "Northwind Labs"), "applied");
    const harbor = await prepared(bridge, (await seedJob(bridge.workspace, bridge.clock, fixtureJob(HARBOR_JOB))).jobId);
    const quill = await prepared(bridge, (await seedJob(bridge.workspace, bridge.clock, fixtureJob(HOSTILE_JOB))).jobId);
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    const failed = (await store.get(harbor))!;
    expect(failed.stage).toBe("saved");
    expect(failed.processing.status).toBe("failed");
    const waiting = (await store.get(quill))!;
    expect(waiting.processing.status).toBe("waiting");

    const page = await openBoard(bridge);
    expect(page.all(".stage h3").map((heading) => heading.textContent)).toEqual([
      "Saved (2)",
      "Preparing (0)",
      "Ready (1)",
      "Applied (1)",
      "Interviewing (0)",
      "Offer (0)",
      "Rejected (0)",
      "Withdrawn (0)",
    ]);
    expect(column(page, "saved").sort()).toEqual([harbor, quill].sort());
    expect(column(page, "ready")).toEqual([ready.taskId]);
    expect(column(page, "applied")).toEqual([applied.taskId]);
    expect(page.byId("empty-offer").textContent).toBe("None.");

    // The failed preparation: its line says why, in the refused style, and its card stays under Saved.
    const failure = page.byId(`state-${harbor}`);
    expect(failure.className).toContain("refused");
    expect(failure.textContent).toBe(failed.processing.error);
    expect(page.byId(`card-${harbor}`).closest("[data-stage]")?.getAttribute("data-stage")).toBe("saved");

    // Waiting on the person's answers: "Needs your answer" in amber, the page's one decision.
    const answer = page.byId(`state-${quill}`);
    expect(answer.className).toContain("decision");
    expect(answer.querySelector(".badge.warn")?.textContent).toBe("Needs your answer");
    expect(answer.textContent).toBe("Needs your answer 2 questions left. Answer on the Applications page.");
    expect(page.all(".badge.warn")).toHaveLength(1);
    expect(page.all(".decision")).toHaveLength(1);

    // Only a Ready application can be chosen for a session.
    expect(page.all("input[type=checkbox]").map((box) => box.id)).toEqual([`pick-${ready.taskId}`]);
    expect(page.byId(`name-${ready.taskId}`).textContent).toBe("Platform Lead · Fernwood");
    expect(page.byId("runs-line").textContent).toMatch(/^Runs today: 2 of \d+\. Each preparation uses one\.$/);
    expect(page.visibleText()).not.toMatch(UUID);
  });

  it("an empty board lists every stage with nothing in it, and says where a session goes with no browser paired", async () => {
    const bridge = await boardBridge();
    const page = await openBoard(bridge);
    expect(page.all(".stage").map((stage) => stage.getAttribute("data-stage"))).toEqual(["saved", "preparing", "ready", "applied", "interviewing", "offer", "rejected", "withdrawn"]);
    expect(page.all(".stage p.muted").map((node) => node.textContent)).toEqual(Array(8).fill("None."));
    expect(page.byId("start-device").textContent).toBe("No browser is paired, so a session is written to outbox/application-session.json for the extension to import by hand. Pair one on the Status page.");
    expect(page.byId("start-device").querySelector("code")?.textContent).toBe("outbox/application-session.json");
    expect(page.byId("start-submit").getAttribute("aria-disabled")).toBe("true");
    expect(page.byId("runs-line").textContent).toMatch(/^Runs today: 0 of \d+\. Each preparation uses one\.$/);
    expect(page.lines).toEqual([]);
  });
});

describe("the board shows the paused budget (P08's deliverable on this page)", () => {
  it("names the pause and its reason, with Settings to resume and the Runs page to see why", async () => {
    const bridge = await boardBridge();
    await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    await pauseBudget(bridge.workspace, bridge.clock, "the model provider's rate limit");
    const page = await openBoard(bridge);
    const line = page.byId("runs-line");
    expect(line.textContent).toBe("Runs are paused: the model provider's rate limit. Nothing is prepared until you resume them in Settings; the Runs page shows why.");
    expect(line.className).toContain("blocked");
    expect(page.all("#runs-line a").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Settings", "/ui/settings#budget-section"],
      ["Runs", "/ui/runs"],
    ]);
  });
});

describe("starting a session from the board", () => {
  it("names the chosen applications, queues one command with each stored job URL for the paired browser, and the cards then say they're waiting", async () => {
    const bridge = await boardBridge();
    await pairDevice(bridge);
    const lead = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const harbor = await seedApplication(bridge.workspace, bridge.clock, postingFor("Platform Engineer", "Harbor"));
    const page = await openBoard(bridge);
    expect(page.byId("start-device").textContent).toMatch(/^A session opens in the browser you paired on .+, when you start it from the extension there\.$/);

    // With nothing chosen, Start says what to do and sends nothing.
    page.press("start-submit");
    await until(() => page.lines.length === 1, "the refusal");
    expect(page.lines).toEqual(["Not started: choose at least one Ready application."]);

    choose(page, lead.taskId);
    choose(page, harbor.taskId);
    expect(page.byId("start-chosen").textContent).toBe("Chosen: “Platform Lead · Fernwood” and “Platform Engineer · Harbor”.");
    expect(page.byId("start-submit").getAttribute("aria-disabled")).toBe("false");
    page.submit("start-form");
    await until(() => page.lines.includes("Started “Apply today”: 2 applications waiting for your browser."), "the start");
    await until(() => page.document.getElementById(`waiting-${lead.taskId}`) !== null, "the waiting cards");
    expect(page.byId(`waiting-${harbor.taskId}`).textContent).toBe("Waiting to open in your browser.");
    expect(page.document.getElementById(`pick-${lead.taskId}`)).toBeNull();
    expect(page.document.activeElement?.id).toBe("start-submit");
    expect(page.byId("start-submit").getAttribute("aria-disabled")).toBe("true");

    const commands = await bridge.ctx.commands.list();
    expect(commands).toHaveLength(1);
    const command = openApplicationGroupSchema.parse(commands[0]!.command);
    expect(command.payload.items.map((item) => [item.taskId, item.url])).toEqual([
      [lead.taskId, platformLeadJob().url],
      [harbor.taskId, postingFor("Platform Engineer", "Harbor").url],
    ]);
    // A session never moves a stage: both are still Ready.
    expect(column(page, "ready").sort()).toEqual([lead.taskId, harbor.taskId].sort());
    expect(page.visibleText()).not.toMatch(UUID);
  });
});

describe("moving a card on the board", () => {
  it("moves the stage the person chose, and focus follows the card to its new column", async () => {
    const bridge = await boardBridge();
    const lead = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openBoard(bridge);
    page.byId(`move-${lead.taskId}`).value = "applied";
    page.press(`move-submit-${lead.taskId}`);
    await until(() => page.lines.includes("Moved “Platform Lead · Fernwood” to Applied."), "the move");
    await until(() => column(page, "applied").includes(lead.taskId), "the card in Applied");
    expect(column(page, "ready")).toEqual([]);
    expect(page.document.activeElement?.id).toBe(`move-submit-${lead.taskId}`);
    expect(page.byId(`move-submit-${lead.taskId}`).closest("[data-stage]")?.getAttribute("data-stage")).toBe("applied");
    expect((await new ApplicationsStore(bridge.workspace, bridge.clock).get(lead.taskId))?.stage).toBe("applied");
  });

  it("refuses a move made on a board that is out of date, and moves nothing", async () => {
    const bridge = await boardBridge();
    const lead = await seedApplication(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openBoard(bridge);
    // Elsewhere (the side panel, another tab), the application changes after the board loaded it.
    const store = new ApplicationsStore(bridge.workspace, bridge.clock);
    await store.update(lead.taskId, (current) => ({ ...current, stage: "interviewing" }));
    page.byId(`move-${lead.taskId}`).value = "applied";
    page.press(`move-submit-${lead.taskId}`);
    await until(() => page.outcomes().length > 0, "the refusal");
    // A line that names a job fits 80 characters, so the name is cut at a word.
    expect(page.outcomes()).toEqual(["Not moved: “Platform Lead…” changed since; the board shows it as it is now."]);
    expect(page.byId("last-action").className).toContain("refused");
    expect((await store.get(lead.taskId))?.stage).toBe("interviewing");
    await until(() => column(page, "interviewing").includes(lead.taskId), "the card as it is now");
    expect(page.document.activeElement?.id).toBe(`move-submit-${lead.taskId}`);
  });
});
