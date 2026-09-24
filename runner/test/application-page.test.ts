import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import applicationsModule, { waitForPreparationQueue } from "../server/routes/applications.ts";
import { ProfileStore } from "../store/profile.ts";
import { citedLabels } from "../validate/text.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";
import {
  FERNWOOD_JOB,
  fixtureJob,
  GOOD_COVER_LETTER,
  GOOD_RESUME,
  HOSTILE_JOB,
  INJECTION_PHRASES,
  platformLeadJob,
  scriptedModel,
  seedDetails,
  seedJob,
  seedReadyProfile,
  type ParsedPrompt,
  type Planner,
  type ScriptedInput,
  type SeedProfileOptions,
} from "./preparation-helpers.ts";

/**
 * The Applications page's own script (`runner/ui/application.html` +
 * `assets/application.js`), run in a DOM against the real
 * `/api/applications` routes and a scripted model (the happy-dom technique
 * of `jobs-page.test.ts`, P04, duplicated because that file exports
 * nothing).
 *
 * The UI-critic rules this page holds itself to: one live region, each
 * outcome announced once in one short sentence; focus never dropped, and a
 * focused node never rebuilt; aria-disabled while a request is in flight;
 * amber only for an open question; open sections stay open across a
 * refresh; and no field name, status code or id in visible text (claim
 * labels appear only inside "What changed and why").
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const MODULES: readonly LoadedRouteModule[] = [{ name: "applications", module: applicationsModule }];
const realSetTimeout = globalThis.setTimeout;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Busy words: shown while a request takes a moment, never an outcome. */
const BUSY = new Set(["Starting…", "Saving…"]);

interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly className: string;
  hidden: boolean;
  open: boolean;
  value: string;
  checked: boolean;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  readonly body: DomNode;
  getElementById(id: string): DomNode | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  dispatchEvent(event: unknown): boolean;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
  readonly MutationObserver: new (callback: () => void) => { observe(node: DomNode, options: Record<string, boolean>): void };
  requestAnimationFrame(callback: (time: number) => void): unknown;
  setTimeout(callback: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly happyDOM: { close(): Promise<void> };
}

const { Window } = createRequire(path.join(HERE, "..", "..", "extension", "package.json"))("happy-dom") as {
  Window: new (options: { url: string; width: number; height: number }) => DomWindow;
};

const GLOBALS = ["window", "document", "requestAnimationFrame", "fetch", "setTimeout", "clearTimeout"] as const;
const saved = new Map<string, unknown>(GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const pages: Page[] = [];
const bridges: TestBridge[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

afterEach(async () => {
  while (pages.length > 0) {
    const page = pages.pop()!;
    page.setVisibility("hidden");
    await sleep(50);
    await page.window.happyDOM.close();
  }
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
  // Nothing a test started keeps running into the next one.
  while (bridges.length > 0) await waitForPreparationQueue(bridges.pop()!.workspace.root);
});

type Intercept = (input: string, init: { method?: string; body?: string }) => Promise<Response> | undefined;

interface Page {
  readonly document: DomDocument;
  readonly window: DomWindow;
  /** Every text the live line showed, in order. */
  readonly lines: string[];
  readonly requests: string[];
  byId(id: string): DomNode;
  /** The live line's outcomes: every text it showed, less the busy words. */
  outcomes(): string[];
  type(id: string, text: string): void;
  submit(formId: string): void;
  setVisibility(state: "visible" | "hidden"): void;
  refreshNow(): void;
}

async function until(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function openPage(bridge: TestBridge, options: { intercept?: Intercept } = {}): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/application`, width: 1280, height: 800 });
  const html = await readFile(path.join(UI, "application.html"), "utf8");
  (window.document as unknown as { body: { innerHTML: string } }).body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  const requests: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
  g.setTimeout = (callback: () => void, ms?: number) => window.setTimeout(callback, ms);
  g.clearTimeout = (handle: unknown) => window.clearTimeout(handle);
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push(`${init.method ?? "GET"} ${input}`);
    const stubbed = options.intercept?.(input, init);
    if (stubbed) return stubbed;
    return bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
  };
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const lineText = () => byId("last-action").querySelector(".text")?.textContent ?? "";
  const lines: string[] = [];
  let lastSeen = lineText();
  new window.MutationObserver(() => {
    const now = lineText();
    if (now === lastSeen) return;
    lastSeen = now;
    if (now !== "") lines.push(now);
  }).observe(byId("last-action"), { childList: true, subtree: true, characterData: true });

  let visibility: "visible" | "hidden" = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const page: Page = {
    document,
    window,
    lines,
    requests,
    byId,
    outcomes: () => lines.filter((line) => !BUSY.has(line)),
    type: (id, text) => {
      const field = byId(id);
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    submit: (formId) => {
      byId(formId).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    setVisibility: (state) => {
      visibility = state;
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    refreshNow: () => page.setVisibility("visible"),
  };
  pages.push(page);
  vi.resetModules();
  await import(path.join(UI, "assets", "application.js"));
  await until(() => (document.getElementById("applications-list")?.textContent ?? "").trim() !== "Loading…", "the applications list to finish loading");
  return page;
}

// --- Scripted models -------------------------------------------------------------

type Cover = { readonly claims: readonly string[] } | { readonly gap: string } | "not";

const PLATFORM_LEAD: readonly Cover[] = [{ claims: ["C1"] }, { claims: ["C3"] }, { claims: ["C5"] }];
/** job-fernwood.json: nothing confirmed shows eight years, or distributed systems work, so the model asks. */
const FERNWOOD: readonly Cover[] = [
  { gap: "How many years of backend engineering experience can you show?" },
  { claims: ["C1", "C8"] },
  { gap: "Which of your work shows distributed systems experience?" },
];
/** job-hostile.json: two real requirements with no evidence, and the injected line set aside. */
const HOSTILE: readonly Cover[] = [{ gap: "How many years of professional experience can you show?" }, { gap: "Which of your work used Node.js or TypeScript?" }, "not"];

function confirmedOnly(statements: readonly string[], confirmed: ReadonlySet<string>): string[] {
  return statements.filter((statement) => citedLabels(statement).every((label) => confirmed.has(label)));
}

/** A model that behaves: it accounts for every requirement, asks where no confirmed claim meets one, and drafts only from claims it was shown. */
function honest(coverage: readonly Cover[]): Planner {
  return (prompt: ParsedPrompt) => {
    const confirmed = new Set(prompt.claims.map((claim) => claim.label));
    const requirements: ScriptedInput["requirements"] = prompt.requirements.map((_text, index) => {
      const requirement = index + 1;
      const spec = coverage[index] ?? { gap: `What in your experience meets requirement ${requirement}?` };
      if (prompt.leaveOut.includes(requirement)) return { requirement, status: "left_out" };
      if (spec === "not") return { requirement, status: "not_a_requirement" };
      if ("gap" in spec) return { requirement, status: "gap", question: spec.gap };
      return { requirement, status: "covered", claims: spec.claims.filter((label) => confirmed.has(label)) };
    });
    if (requirements.some((entry) => entry.status === "gap")) return { skills: ["claim-matching"], calls: [{ requirements }] };
    const resume = { sections: GOOD_RESUME.sections.map((section) => ({ heading: section.heading, statements: confirmedOnly(section.statements, confirmed) })).filter((section) => section.statements.length > 0) };
    const letter = prompt.coverLetter ? { coverLetter: { paragraphs: GOOD_COVER_LETTER.paragraphs.map((paragraph) => confirmedOnly(paragraph, confirmed)).filter((paragraph) => paragraph.length > 0) } } : {};
    return { skills: ["claim-matching", "resume-drafting", ...(prompt.coverLetter ? ["cover-letter-drafting"] : [])], calls: [{ requirements, resume, ...letter }] };
  };
}

/** A draft the tool refuses, and a model that never revises it: one number no claim states, and the excluded metric. */
const refusedOnly: Planner = () => ({
  skills: ["claim-matching", "resume-drafting"],
  calls: [
    {
      requirements: [
        { requirement: 1, status: "covered", claims: ["C1"] },
        { requirement: 2, status: "covered", claims: ["C3"] },
        { requirement: 3, status: "covered", claims: ["C5"] },
      ],
      resume: {
        sections: [
          { heading: "Experience", statements: ["Led the payments infrastructure team at Northwind Labs, redesigning the ledger service behind its billing [C1].", "Shipped the on-call rotation tooling used by 5 engineering teams [C3]."] },
          { heading: "Projects", statements: ["Grew signups 500% after launching the self-serve onboarding flow [C1]."] },
        ],
      },
    },
  ],
});

async function bridgeWith(planner: Planner, options: { profile?: SeedProfileOptions; details?: boolean } = {}): Promise<TestBridge> {
  const holder: { bridge?: TestBridge } = {};
  const model = scriptedModel(() => ({ workspace: holder.bridge!.workspace, clock: holder.bridge!.clock }), planner);
  const bridge = await makeBridge({ modules: MODULES, eve: model.eve });
  holder.bridge = bridge;
  bridges.push(bridge);
  await seedReadyProfile(bridge.workspace, bridge.clock, options.profile ?? {});
  if (options.details !== false) await seedDetails(bridge.workspace, bridge.clock);
  return bridge;
}

/** Prepares `jobId` through the API, not the page (another tab, say), and waits for it to finish. */
async function prepareElsewhere(bridge: TestBridge, jobId: string): Promise<void> {
  const response = await bridge.request("/api/applications/prepare", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ jobId, coverLetter: false }) });
  expect(response.status).toBe(200);
  await waitForPreparationQueue(bridge.workspace.root);
}

/** Selects `jobId` and presses Prepare, as a person would (the pressed button takes focus first). */
function pressPrepare(page: Page, jobId: string, coverLetter = false): void {
  page.byId("prepare-job").value = jobId;
  page.byId("prepare-cover").checked = coverLetter;
  page.byId("prepare-submit").focus();
  page.submit("prepare-form");
}

/** Presses a button the way a person does: focus, then click. */
function press(page: Page, id: string): DomNode {
  const button = page.byId(id);
  button.focus();
  button.click();
  return button;
}

function visibleText(page: Page): string {
  return page.document.body.textContent ?? "";
}

function all(page: Page, selector: string): DomNode[] {
  return Array.from(page.document.querySelectorAll(selector));
}

function taskIdOf(page: Page): string {
  const row = page.document.querySelector(".app-row");
  if (!row) throw new Error("no application row");
  return row.id.replace("app-row-", "");
}

describe("Applications page: first load", () => {
  it("shows the empty states and what preparation needs, in plain words, and announces nothing", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const page = await openPage(bridge);
    expect(page.byId("jobs-empty").hidden).toBe(false);
    expect(page.byId("prepare-form").hidden).toBe(true);
    expect(page.byId("applications-empty").hidden).toBe(false);
    expect(page.byId("applications-list").hidden).toBe(true);
    expect(page.byId("detail-section").hidden).toBe(true);
    expect(page.byId("ready-profile").textContent).toBe("Your career profile, version 1, is approved.");
    expect(page.byId("ready-runner").textContent).toBe("The runner's agent is running.");
    expect(page.byId("ready-details").textContent).toBe("Documents will carry the name “Ada Quill”.");
    expect(page.byId("details-name").value).toBe("Ada Quill");
    expect(page.lines).toEqual([]);
  });

  it("says preparation is locked, and that the workflow will not guess, while the profile isn't approved", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD), { profile: { approve: false } });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    expect(page.byId("ready-profile").textContent).toBe("Preparation is locked: the career profile has not been approved yet. The workflow will not guess. See the Profile page.");
    expect(page.byId("ready-profile").className).toContain("ready-blocked");
    pressPrepare(page, jobId);
    await until(() => page.outcomes().length > 0, "the refusal");
    expect(page.outcomes()).toEqual(["Not prepared: preparation is locked until your profile is ready."]);
    expect(page.document.activeElement?.id).toBe("prepare-submit");
    expect(page.byId("prepare-submit").getAttribute("aria-disabled")).toBe("false");
    expect(page.byId("applications-empty").hidden).toBe(false);
  });
});

describe("Applications page: preparing", () => {
  it("announces the start at once and the result once, opens the application without moving focus, and lists the version's exports and diff", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    expect(page.byId("prepare-job").textContent).toBe("Platform Lead · Fernwood");

    pressPrepare(page, jobId);
    await until(() => page.lines.includes("Prepared “Platform Lead · Fernwood”: version 1 is ready."), "the result", 10_000);
    expect(page.outcomes()).toEqual(["Preparing “Platform Lead · Fernwood”…", "Prepared “Platform Lead · Fernwood”: version 1 is ready."]);
    expect(page.document.activeElement?.id).toBe("prepare-submit");
    expect(page.byId("detail-section").hidden).toBe(false);
    expect(page.byId("detail-title").textContent).toBe("Platform Lead · Fernwood");
    await until(() => page.document.querySelector(".version") !== null, "the version");
    expect(page.byId("detail-stage").textContent).toBe("Ready to send · 1 version");
    expect(page.document.querySelector(".app-meta")?.textContent).toBe("Ready to send · version 1");
    // Each requirement beside the evidence that meets it, in the claims' own words.
    expect(all(page, ".coverage li").map((node) => node.textContent)).toEqual([
      "Requirement 1: “Experience leading platform or infrastructure teams” — met by “Led the payments infrastructure team at Northwind Labs, redesigning the ledger service that powers Northwind Labs' billing.”",
      "Requirement 2: “Built tooling that other engineering teams depend on” — met by “Shipped the on-call rotation tooling used by three engineering teams.”",
      "Requirement 3: “Open-source maintainership” — met by “Maintainer of Ledgerkit, an open-source ledger reconciliation library.”",
    ]);

    const links = all(page, ".exports a");
    expect(links.map((link) => link.textContent)).toEqual(["Resume · Markdown", "Resume · Word", "Resume · PDF", "What changed and why · Markdown"]);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/api\/applications\/[0-9a-f-]{36}\/docs\/(resume|diff)-v1\.(md|docx|pdf)$/);
      expect(link.getAttribute("download")).toMatch(/^(resume|diff)-v1\.(md|docx|pdf)$/);
    }
    // Each sentence beside the claim it cites, and how its wording differs: the one place labels show, on purpose.
    const diff = page.document.querySelector(".changes-detail")!;
    expect(diff.querySelector("summary")?.textContent).toBe("What changed and why");
    expect(diff.textContent).toContain("“Shipped the on-call rotation tooling used by three engineering teams.”Cites C3 (fact): “Shipped the on-call rotation tooling used by three engineering teams.”Same words as C3.");
    expect(diff.textContent).toContain("Cites C1 (fact): “Led the payments infrastructure team at Northwind Labs, redesigning the ledger service that powers Northwind Labs' billing.”");
    expect(diff.textContent).toContain("Reworded from C1: leaves out “that powers Northwind Labs'”; adds “behind its”.");
    // Nowhere outside it.
    const outside = visibleText(page).replace(diff.textContent ?? "", "");
    expect(outside).not.toMatch(/\bC\d\b/);
    expect(visibleText(page)).not.toMatch(UUID);
    expect(visibleText(page)).not.toMatch(/\b[a-z]+_[a-z_]+\b/);

    // Preparing again with nothing changed writes nothing, and says so once; the pressed button keeps focus.
    const again = press(page, "detail-prepare");
    await until(() => page.outcomes().length === 3, "the second outcome");
    expect(page.outcomes()[2]).toBe("Already prepared: “Platform Lead · Fernwood” matches version 1; nothing new.");
    expect(page.document.activeElement).toBe(again);
    expect(page.byId("detail-prepare")).toBe(again);
    expect(all(page, ".version")).toHaveLength(1);
  });

  it("the Prepare button is aria-disabled while its request is in flight, a second press sends nothing, and it keeps focus", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const page = await openPage(bridge, {
      intercept: (input, init) => {
        if (input !== "/api/applications/prepare" || init.method !== "POST") return undefined;
        return held.then(() => bridge.request(input, { method: "POST", body: init.body, headers: SAME_ORIGIN }));
      },
    });
    pressPrepare(page, jobId);
    await until(() => page.byId("prepare-submit").getAttribute("aria-disabled") === "true", "the button to be busy");
    page.submit("prepare-form");
    await sleep(400);
    expect(page.requests.filter((request) => request === "POST /api/applications/prepare")).toHaveLength(1);
    expect(page.lines).toEqual(["Starting…"]);
    release();
    await until(() => page.byId("prepare-submit").getAttribute("aria-disabled") === "false", "the button to be free");
    expect(page.document.activeElement?.id).toBe("prepare-submit");
    await until(() => page.lines.some((line) => line.startsWith("Prepared")), "the result", 10_000);
  });

  it("a refusal from the runner is one short line, and the button stays usable", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD), { details: false });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    expect(page.byId("ready-details").textContent).toBe("Add your name below: every document carries it.");
    pressPrepare(page, jobId);
    await until(() => page.outcomes().length > 0, "the refusal");
    expect(page.outcomes()).toEqual(["Not prepared: add your name for the documents first."]);
    expect(page.byId("prepare-submit").getAttribute("aria-disabled")).toBe("false");
    expect(page.document.activeElement?.id).toBe("prepare-submit");
  });

  it("opens an application from its row, moving focus to its heading", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const page = await openPage(bridge);
    expect(page.byId("detail-section").hidden).toBe(true);
    expect(page.document.querySelector(".app-meta")?.textContent).toBe("Ready to send · version 1");
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.activeElement?.id === "detail-title", "the heading to take focus");
    expect(page.byId("detail-section").hidden).toBe(false);
    expect(page.document.querySelector(".app-open")?.getAttribute("aria-current")).toBe("true");
    expect(page.lines).toEqual([]);
  });
});

describe("Applications page: gap questions", () => {
  it("shows open questions in amber, takes each answer with a button that keeps focus, and continues once every question is answered", async () => {
    const bridge = await bridgeWith(honest(FERNWOOD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const page = await openPage(bridge);
    pressPrepare(page, jobId);
    await until(() => page.lines.includes("Needs your answers: “Staff Software Engineer · Fernwood”."), "the questions", 10_000);
    await until(() => page.document.getElementById("detail-questions") !== null, "the questions block");

    const block = page.byId("detail-questions");
    expect(block.className).toContain("decision");
    expect(block.textContent).toContain("Requirement 1: “8+ years of backend engineering experience”");
    expect(block.textContent).toContain("How many years of backend engineering experience can you show?");
    expect(block.textContent).toContain("Requirement 3: “Strong distributed systems fundamentals”");
    expect(page.byId("questions-next").textContent).toBe("Answer all 2 questions to continue preparing.");
    // The one action waits for the answers.
    expect(page.byId("detail-prepare").textContent).toBe("Continue preparing");
    expect(page.byId("detail-prepare").getAttribute("aria-disabled")).toBe("true");
    // Amber is the open question's alone: its block, and the row's one badge.
    expect(all(page, ".badge.warn").map((node) => node.textContent)).toEqual(["Needs your answer"]);
    expect(all(page, ".decision")).toHaveLength(1);

    const taskId = taskIdOf(page);
    const leaveOutFirst = press(page, `answer-${taskId}-1-leave_out`);
    await until(() => leaveOutFirst.getAttribute("aria-pressed") === "true", "the first answer");
    expect(page.byId(`answer-${taskId}-1-leave_out`)).toBe(leaveOutFirst);
    expect(page.document.activeElement).toBe(leaveOutFirst);
    expect(page.byId(`answer-${taskId}-1-add_evidence`).getAttribute("aria-pressed")).toBe("false");
    expect(page.outcomes().at(-1)).toBe("Answered: requirement 1 will be left out.");
    expect(page.byId("questions-next").textContent).toBe("Answer the last question to continue preparing.");
    expect(page.byId("detail-prepare").getAttribute("aria-disabled")).toBe("true");

    press(page, `answer-${taskId}-3-leave_out`);
    await until(() => page.byId("detail-prepare").getAttribute("aria-disabled") === "false", "Continue preparing to be enabled");
    expect(page.byId("questions-next").textContent).toBe("Every question is answered: continue preparing below.");

    const cont = press(page, "detail-prepare");
    await until(() => page.lines.includes("Prepared “Staff Software Engineer · Fernwood”: version 1 is ready."), "the result", 10_000);
    await until(() => page.document.getElementById("detail-questions") === null, "the questions to go");
    // The same button, now "Prepare again", kept focus the whole time.
    expect(page.byId("detail-prepare")).toBe(cont);
    expect(page.document.activeElement).toBe(cont);
    expect(cont.textContent).toBe("Prepare again");
    expect(all(page, ".badge.warn")).toHaveLength(0);
    expect(all(page, ".decision")).toHaveLength(0);
    expect(page.outcomes().filter((line) => line.startsWith("Prepared") || line.startsWith("Needs"))).toHaveLength(2);
  });

  it("an answer that the evidence belongs in the profile points there, and preparing again says to add it first", async () => {
    const bridge = await bridgeWith(honest(FERNWOOD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const page = await openPage(bridge);
    pressPrepare(page, jobId);
    await until(() => page.document.getElementById("detail-questions") !== null, "the questions block", 10_000);
    const taskId = taskIdOf(page);
    press(page, `answer-${taskId}-1-add_evidence`);
    await until(() => page.outcomes().at(-1) === "Answered: add evidence for requirement 1 to your profile.", "the answer");
    press(page, `answer-${taskId}-3-leave_out`);
    await until(() => page.byId("questions-next").textContent === "Add that evidence on the Profile page and approve it, then prepare this job again.", "the pointer");
    expect(page.byId("questions-next").querySelector("a")?.getAttribute("href")).toBe("/ui/profile");
    expect(page.byId("detail-prepare").textContent).toBe("Prepare again");
    press(page, "detail-prepare");
    await until(() => page.outcomes().at(-1) === "Not prepared: add the missing evidence to your profile first.", "the refusal");
    expect(page.document.activeElement?.id).toBe("detail-prepare");
  });
});

describe("Applications page: refusals in plain words", () => {
  it("lists each refused sentence by its place with what was wrong, and never a rule code, an id or the excluded wording", async () => {
    const bridge = await bridgeWith(refusedOnly);
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    pressPrepare(page, jobId);
    await until(() => page.lines.includes("Couldn't prepare “Platform Lead · Fernwood”; its details say why."), "the failure", 10_000);
    await until(() => page.document.getElementById("detail-problems") !== null, "the refusals");
    const problems = all(page, "#detail-problems li").map((node) => node.textContent);
    expect(problems).toEqual([
      "Resume, Experience, bullet 2: “Shipped the on-call rotation tooling used by 5 engineering teams.” It states a number your confirmed claims don't.",
      "Resume, Projects, bullet 1: It drew on a claim you excluded.",
    ]);
    expect(page.byId("detail-state").textContent).toBe("The draft didn't pass the runner's checks, so nothing was saved.");
    expect(page.byId("detail-stage").textContent).toBe("Saved");
    const text = visibleText(page);
    for (const needle of ["Grew signups", "500", "processing", "idempotency", "[C"]) expect(text).not.toContain(needle);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/); // no rule code or field name
    expect(text).not.toMatch(UUID);
    // A refusal is the page's refusal rule, never amber.
    expect(all(page, ".badge.warn")).toHaveLength(0);
    expect(all(page, ".decision")).toHaveLength(0);
    expect(page.byId("detail-prepare").getAttribute("aria-disabled")).toBe("false");
  });
});

describe("Applications page: a hostile posting", () => {
  it("is prepared like any other, and none of its injected text reaches the page", async () => {
    const bridge = await bridgeWith(honest(HOSTILE));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(HOSTILE_JOB));
    const page = await openPage(bridge);
    pressPrepare(page, jobId, true);
    await until(() => page.document.getElementById("detail-questions") !== null, "the questions", 10_000);
    const taskId = taskIdOf(page);
    expect(all(page, "#detail-questions .question")).toHaveLength(2);
    press(page, `answer-${taskId}-1-leave_out`);
    await until(() => page.outcomes().at(-1) === "Answered: requirement 1 will be left out.", "the first answer");
    press(page, `answer-${taskId}-2-leave_out`);
    await until(() => page.byId("detail-prepare").getAttribute("aria-disabled") === "false", "Continue preparing");
    press(page, "detail-prepare");
    await until(() => page.lines.includes("Prepared “Backend Engineer · Quill”: version 1 is ready."), "the result", 10_000);
    await until(() => page.document.querySelector(".version") !== null, "the version");
    expect(all(page, ".exports a").map((link) => link.textContent)).toContain("Cover letter · Word");
    expect(all(page, `#coverage-${taskId} li`).map((node) => node.textContent)).toEqual([
      "Requirement 1: “4+ years of experience” — left out, as you asked.",
      "Requirement 2: “Node.js and TypeScript” — left out, as you asked.",
      "Requirement 3 — set aside: this line isn't something the job asks of you.",
    ]);
    const text = visibleText(page).toLowerCase();
    for (const phrase of INJECTION_PHRASES) expect(text).not.toContain(phrase);
    expect(text).not.toContain("system:");
  });
});

describe("Applications page: the documents' header", () => {
  it("refuses an empty name on its field, then saves one and says so once", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD), { details: false });
    const page = await openPage(bridge);
    page.byId("details-submit").focus();
    page.submit("details-form");
    expect(page.byId("details-name").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("details-name-error").textContent).toBe("Enter your name as it should appear on your documents.");
    expect(page.byId("details-name-error").hidden).toBe(false);
    expect(page.document.activeElement?.id).toBe("details-name");
    await until(() => page.outcomes().length === 1, "the refusal");
    expect(page.outcomes()).toEqual(["Not saved."]);

    page.type("details-name", "Ada Quill");
    expect(page.byId("details-name").getAttribute("aria-invalid")).toBeNull();
    expect(page.byId("details-name-error").hidden).toBe(true);
    page.type("details-contact", "ada.quill@example.com");
    page.byId("details-submit").focus();
    page.submit("details-form");
    await until(() => page.outcomes().length === 2, "the save");
    expect(page.outcomes()[1]).toBe("Saved: your documents will carry this name.");
    await until(() => page.byId("ready-details").textContent === "Documents will carry the name “Ada Quill”.", "the ready line");
    expect(page.document.activeElement?.id).toBe("details-submit");
  });
});

describe("Applications page: refreshing in place", () => {
  it("a refresh that brings a new version keeps an open “What changed and why” open, its summary focused, and announces nothing", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const page = await openPage(bridge);
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.querySelector(".changes-detail") !== null, "the version");
    const details = page.document.querySelector(".changes-detail")!;
    details.open = true;
    const summary = details.querySelector("summary")!;
    summary.focus();

    // Elsewhere, the person excludes their degree and prepares again: version 2 replaces version 1.
    const profiles = new ProfileStore(bridge.workspace, bridge.clock);
    await profiles.decideClaim((await profiles.read()).claims[5]!.id, "excluded");
    await prepareElsewhere(bridge, jobId);
    page.refreshNow();
    await until(() => all(page, ".version").length === 2, "version 2");
    expect(all(page, ".version h4").map((node) => node.textContent)).toEqual(["Version 2 · resume", "Version 1 · resume"]);
    expect(page.document.querySelector(".changes-detail[open]")).toBe(details);
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(true);
    expect(page.document.activeElement).toBe(summary);
    expect(visibleText(page)).toContain("It cites 1 claim you have since excluded or changed. Prepare again for a version without it.");
    expect(page.lines).toEqual([]);
  });
});

describe("Applications page: the line", () => {
  it("every line is one sentence of 90 characters or fewer, and 80 or fewer when it names a job", async () => {
    const bridge = await bridgeWith(honest(FERNWOOD));
    const long = { ...FERNWOOD_JOB.structured, title: "Staff Software Engineer, Platform Reliability and Developer Experience (Remote, Europe or Americas)" };
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, { ...fixtureJob(FERNWOOD_JOB), structured: long });
    const page = await openPage(bridge);
    pressPrepare(page, jobId);
    await until(() => page.lines.some((line) => line.startsWith("Needs your answers")), "the questions", 10_000);
    expect(page.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of page.lines) expect(line.length, line).toBeLessThanOrEqual(line.includes("“") ? 80 : 90);
  });
});
