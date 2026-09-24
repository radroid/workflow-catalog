import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import applicationsModule, { waitForPreparationQueue } from "../server/routes/applications.ts";
import { ApplicationsStore } from "../store/applications.ts";
import { pauseBudget } from "../store/budget.ts";
import { JobsStore } from "../store/jobs.ts";
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
  type ScriptedModel,
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
    // A refresh already under way still reads the workspace, and every read takes the profile's lock file; the
    // workspace is removed next, so let it finish first (on a loaded machine, removing it mid-read failed with ENOTEMPTY).
    await page.quiet();
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
  /** Resolves once none of the page's requests has been in flight for 100 ms (at most 10 s). */
  quiet(): Promise<void>;
}

async function until(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}${whatThePageShows()}`);
    await sleep(10);
  }
}

/** What the open page showed when a wait timed out: enough to tell a race on another machine from a wrong result. */
function whatThePageShows(): string {
  const page = pages.at(-1);
  if (!page) return "";
  const texts = (selector: string) => Array.from(page.document.querySelectorAll(selector)).map((node) => node.textContent ?? "");
  const shown = {
    lines: page.lines,
    rows: texts(".app-row"),
    detail: page.document.getElementById("detail-section")?.hidden === false ? texts("#detail-status, #detail-questions, #detail-problems, #detail-actions") : "hidden",
    requests: page.requests.slice(-12),
  };
  return `. The page showed: ${JSON.stringify(shown)}`;
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
  let inFlight = 0;
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push(`${init.method ?? "GET"} ${input}`);
    const stubbed = options.intercept?.(input, init);
    inFlight += 1;
    const response = stubbed ?? bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
    return response.finally(() => (inFlight -= 1));
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
    quiet: async () => {
      const deadline = Date.now() + 10_000;
      let busyAt = Date.now();
      while (Date.now() < deadline) {
        if (inFlight > 0) busyAt = Date.now();
        else if (Date.now() - busyAt >= 100) return;
        await sleep(10);
      }
    },
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

async function bridgeAndModel(planner: Planner, options: { profile?: SeedProfileOptions; details?: boolean } = {}): Promise<{ bridge: TestBridge; model: ScriptedModel }> {
  const holder: { bridge?: TestBridge } = {};
  const model = scriptedModel(() => ({ workspace: holder.bridge!.workspace, clock: holder.bridge!.clock }), planner);
  const bridge = await makeBridge({ modules: MODULES, eve: model.eve });
  holder.bridge = bridge;
  bridges.push(bridge);
  await seedReadyProfile(bridge.workspace, bridge.clock, options.profile ?? {});
  if (options.details !== false) await seedDetails(bridge.workspace, bridge.clock);
  return { bridge, model };
}

async function bridgeWith(planner: Planner, options: { profile?: SeedProfileOptions; details?: boolean } = {}): Promise<TestBridge> {
  return (await bridgeAndModel(planner, options)).bridge;
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
    // The daily run limit, under "Before preparing" (revision 1, V18).
    expect(page.byId("ready-runs").textContent).toBe("Runs today: 0 of 10. Each preparation uses one; the daily limit is in Settings.");
    expect(page.byId("ready-runs").querySelector("a")?.getAttribute("href")).toBe("/ui/settings");
    expect(page.byId("ready-details").textContent).toBe("Documents will carry the name “Ada Quill”.");
    expect(page.byId("details-name").value).toBe("Ada Quill");
    expect(page.byId("details-name-note").hidden).toBe(true);
    expect(page.lines).toEqual([]);
  });

  it("says preparation is locked, and that the workflow will not guess, while the profile isn't approved", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD), { profile: { approve: false } });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    // Approval lives on Onboarding, so that's where the line points; one pointer, not two (revision 1, V12, V17).
    expect(page.byId("ready-profile").textContent).toBe("Preparation is locked: the career profile has not been approved yet. The workflow will not guess. Finish it on the Onboarding page.");
    expect(all(page, "#ready-profile a").map((link) => link.getAttribute("href"))).toEqual(["/ui/onboarding"]);
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

    // Each link names its version, and downloads under the person's name, the document and the job (revision 1, V14, V18).
    const links = all(page, ".exports a");
    expect(links.map((link) => link.textContent)).toEqual(["Resume, version 1 · Markdown", "Resume, version 1 · Word", "Resume, version 1 · PDF", "What changed and why, version 1 · Markdown"]);
    for (const link of links) expect(link.getAttribute("href")).toMatch(/^\/api\/applications\/[0-9a-f-]{36}\/docs\/(resume|diff)-v1\.(md|docx|pdf)$/);
    expect(links.map((link) => link.getAttribute("download"))).toEqual([
      "Ada Quill - Resume - Fernwood Platform Lead.md",
      "Ada Quill - Resume - Fernwood Platform Lead.docx",
      "Ada Quill - Resume - Fernwood Platform Lead.pdf",
      "Ada Quill - What changed in version 1 - Fernwood Platform Lead.md",
    ]);
    expect(all(page, ".export-note")).toHaveLength(0);
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
    // The name is what's missing, so focus goes to its field (revision 1, V18).
    expect(page.document.activeElement?.id).toBe("details-name");
  });

  it("the picker starts on a job whose details are extracted, and a job that isn't says where to extract them (revision 1, V18)", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    bridge.clock.advance(60_000);
    const unextracted = await new JobsStore(bridge.workspace).captureJob({ url: "https://jobs.example/postings/harbor-unextracted", text: "Harbor is hiring. Fictional posting for tests.", extractorVersion: "extractor@0.1.0", capturedAt: bridge.clock.now().toISOString() });
    const page = await openPage(bridge);
    expect(all(page, "#prepare-job option").map((option) => option.getAttribute("value"))).toContain(unextracted.jobId);
    expect(page.byId("prepare-job").value).toBe(jobId);
    page.byId("prepare-job").value = unextracted.jobId;
    page.byId("prepare-job").dispatchEvent(new page.window.Event("change", { bubbles: true }));
    page.byId("prepare-submit").focus();
    page.submit("prepare-form");
    await until(() => page.outcomes().length > 0, "the refusal");
    expect(page.outcomes()).toEqual(["Not prepared: extract this job's details on the Jobs page first."]);
    expect(page.byId("last-action").querySelector("a")?.getAttribute("href")).toBe("/ui/jobs");
    // The person's own choice stays chosen through refreshes.
    page.refreshNow();
    await sleep(100);
    expect(page.byId("prepare-job").value).toBe(unextracted.jobId);
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
    expect(page.byId("questions-next").textContent).toBe("Answer both questions to continue preparing.");
    expect(page.byId("questions-heading").textContent).toBe("Needs your answer");
    expect(page.document.querySelector(".app-status")?.textContent).toBe("Needs your answer 2 questions left.");
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
    // The row's line follows the answers, not the count frozen when it parked (revision 1, V11).
    await until(() => page.document.querySelector(".app-status")?.textContent === "Needs your answer 1 question left.", "the row to count one question");

    press(page, `answer-${taskId}-3-leave_out`);
    await until(() => page.byId("detail-prepare").getAttribute("aria-disabled") === "false", "Continue preparing to be enabled");
    expect(page.byId("questions-next").textContent).toBe("Every question is answered: continue preparing below.");
    // Nothing waits on a decision now: no amber, no "Needs your answer", in the detail or the row.
    await until(() => page.document.querySelector(".app-status")?.textContent === "Ready to continue.", "the row to say it can continue");
    expect(page.byId("questions-heading").textContent).toBe("Your answers");
    expect(all(page, ".decision")).toHaveLength(0);
    expect(page.byId("detail-questions").className).toContain("answered");
    expect(all(page, ".badge.warn")).toHaveLength(0);

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
    // Two claims meeting one requirement are joined with "and" (revision 1, V18).
    await until(() => page.document.querySelector(".coverage") !== null, "the coverage");
    expect(all(page, ".coverage li")[1]?.textContent).toBe(
      "Requirement 2: “Experience leading platform or infrastructure teams” — met by “Led the payments infrastructure team at Northwind Labs, redesigning the ledger service that powers Northwind Labs' billing.” and “Senior Platform Engineer at Northwind Labs.”",
    );
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
    // Evidence is added on Onboarding, so that's where it points (revision 1, V12).
    await until(() => page.byId("questions-next").textContent === "Add that evidence on the Onboarding page and approve it, then prepare this job again.", "the pointer");
    expect(page.byId("questions-next").querySelector("a")?.getAttribute("href")).toBe("/ui/onboarding");
    expect(page.byId("detail-prepare").textContent).toBe("Prepare again");
    await until(() => page.document.querySelector(".app-status")?.textContent === "Waiting for the evidence you're adding.", "the row's line");
    expect(all(page, ".badge.warn")).toHaveLength(0);
    press(page, "detail-prepare");
    await until(() => page.outcomes().at(-1) === "Not prepared: add the missing evidence on the Onboarding page first.", "the refusal");
    expect(page.byId("last-action").querySelector("a")?.getAttribute("href")).toBe("/ui/onboarding");
    expect(page.document.activeElement?.id).toBe("detail-prepare");
  });

  /**
   * The list can see a parked preparation later than its detail does (a list read that spans the preparation's
   * finish reads it running). CI's runner hit this: the person had answered, and then the line announced
   * "Needs your answers". These hold the list back on purpose until the questions have been answered.
   */
  function laggingList(bridge: TestBridge, lagging: () => boolean): Intercept {
    return (input, init) => {
      if (input !== "/api/applications" || (init.method ?? "GET") !== "GET" || !lagging()) return undefined;
      return bridge.request(input, { headers: { cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } }).then(async (response) => {
        const view = (await response.json()) as { applications: Array<Record<string, unknown>> };
        const running = { status: "running", message: "Preparing now. This can take a minute or two." };
        const body = JSON.stringify({ ...view, applications: view.applications.map((entry) => ({ ...entry, state: running })) });
        return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
      });
    };
  }

  /** Prepares Fernwood's job with the list held back, until the questions show from the detail alone; the page then refreshes only when told. */
  async function questionsBeforeTheList() {
    const bridge = await bridgeWith(honest(FERNWOOD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, fixtureJob(FERNWOOD_JOB));
    const lag = { on: true };
    const page = await openPage(bridge, { intercept: laggingList(bridge, () => lag.on) });
    pressPrepare(page, jobId);
    await until(() => page.document.getElementById("detail-questions") !== null, "the questions block", 10_000);
    page.setVisibility("hidden");
    await page.quiet();
    // The list hasn't seen it parked, so nothing was announced yet.
    expect(page.outcomes()).toEqual(["Preparing “Staff Software Engineer · Fernwood”…"]);
    lag.on = false;
    return { bridge, page, taskId: taskIdOf(page) };
  }

  it("once the person answers a question, a list that sees the preparation parked only afterwards announces nothing more", async () => {
    const { page, taskId } = await questionsBeforeTheList();
    press(page, `answer-${taskId}-1-leave_out`);
    await until(() => page.outcomes().includes("Answered: requirement 1 will be left out."), "the answer");
    await page.quiet(); // the answer's own refresh: the list sees it parked now
    expect(page.document.querySelector(".app-status")?.textContent).toBe("Needs your answer 1 question left.");
    page.refreshNow();
    await page.quiet();
    expect(page.outcomes()).toEqual(["Preparing “Staff Software Engineer · Fernwood”…", "Answered: requirement 1 will be left out."]);
  });

  it("a watched preparation whose questions were all answered elsewhere is never announced as needing answers", async () => {
    const { bridge, page, taskId } = await questionsBeforeTheList();
    // Another tab answers both.
    for (const requirement of [1, 3]) {
      const answered = await bridge.request(`/api/applications/${taskId}/answers`, { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ requirement, answer: "leave_out" }) });
      expect(answered.status).toBe(200);
    }
    page.refreshNow();
    await until(() => page.document.querySelector(".app-status")?.textContent === "Ready to continue.", "the list to see it answered");
    await page.quiet();
    expect(page.outcomes()).toEqual(["Preparing “Staff Software Engineer · Fernwood”…"]);
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
    expect(all(page, ".exports a").map((link) => link.textContent)).toContain("Cover letter, version 1 · Word");
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

    // Elsewhere, the person excludes their degree: the latest version says it cites a claim no longer confirmed.
    const profiles = new ProfileStore(bridge.workspace, bridge.clock);
    await profiles.decideClaim((await profiles.read()).claims[5]!.id, "excluded");
    page.refreshNow();
    await until(() => visibleText(page).includes("It cites 1 claim you have since excluded or changed. Prepare again for a version without it."), "the note on version 1");
    // They prepare again: version 2 replaces version 1, which now says so, and no longer asks to prepare again (revision 1, V15).
    await prepareElsewhere(bridge, jobId);
    page.refreshNow();
    await until(() => all(page, ".version").length === 2, "version 2");
    expect(all(page, ".version h4").map((node) => node.textContent)).toEqual(["Version 2 · resume", "Version 1 · resume"]);
    expect(page.document.querySelector(".changes-detail[open]")).toBe(details);
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(true);
    expect(page.document.activeElement).toBe(summary);
    expect(visibleText(page)).not.toContain("It cites 1 claim");
    expect(all(page, ".version-note").map((node) => node.textContent)).toEqual(["Version 2 replaces it."]);
    expect(page.lines).toEqual([]);
  });
});

describe("Applications page: a changed name or contact line (revision 1, V8)", () => {
  it("says the documents don't carry it yet, and Prepare again re-exports them with it as a new version, with no model turn", async () => {
    const { bridge, model } = await bridgeAndModel(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const page = await openPage(bridge);
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.querySelector(".version") !== null, "version 1");

    page.type("details-name", "Ada Q. Quill");
    page.byId("details-submit").focus();
    page.submit("details-form");
    await until(() => page.outcomes().length === 1, "the save");
    expect(page.outcomes()).toEqual(["Saved. Prepare again to put it on your documents."]);
    await until(() => visibleText(page).includes("Your name or contact line has changed since this version. Prepare again to put it on your documents."), "the version note");

    const again = press(page, "detail-prepare");
    await until(() => page.outcomes().length === 2, "the re-export");
    expect(page.outcomes()[1]).toBe("Re-exported “Platform Lead · Fernwood” as version 2, with your new details.");
    expect(model.prompts).toHaveLength(1);
    await until(() => all(page, ".version").length === 2, "version 2");
    expect(page.document.activeElement).toBe(again);
    const [v2, v1] = all(page, ".version");
    expect(v2!.querySelector("p.muted")?.textContent).toMatch(/^Prepared .+ with your updated name and contact line: the same sentences as version 1\. It replaces version 1\.$/);
    expect(v2!.textContent).toContain("Only the name and contact line at the top changed. Every sentence is the same as in version 1, and no model ran.");
    expect(v2!.querySelector(".exports a")?.getAttribute("download")).toBe("Ada Q. Quill - Resume - Fernwood Platform Lead.md");
    expect(v1!.querySelector(".version-note")?.textContent).toBe("Version 2 replaces it.");
    expect(visibleText(page)).not.toContain("Your name or contact line has changed");

    // The same header again is already prepared.
    press(page, "detail-prepare");
    await until(() => page.outcomes().length === 3, "the third outcome");
    expect(page.outcomes()[2]).toBe("Already prepared: “Platform Lead · Fernwood” matches version 2; nothing new.");
  });
});

/** Saves `name` in the documents' header from the page, as a person would, and waits for the save's line. */
async function saveName(page: Page, name: string): Promise<void> {
  const before = page.outcomes().length;
  page.type("details-name", name);
  page.byId("details-submit").focus();
  page.submit("details-form");
  await until(() => page.outcomes().slice(before).some((line) => line.startsWith("Saved")), `the save of ${name}`);
}

describe("Applications page: switching the name back (revision 2, X5)", () => {
  it("Ada, then Zoe, then Ada: Prepare again puts Ada back on the newest documents, and the note clears", async () => {
    const { bridge, model } = await bridgeAndModel(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const page = await openPage(bridge);
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.querySelector(".version") !== null, "version 1");
    const changed = "Your name or contact line has changed since this version. Prepare again to put it on your documents.";

    await saveName(page, "Zoe Quill");
    const button = press(page, "detail-prepare");
    await until(() => all(page, ".version").length === 2, "version 2");
    await saveName(page, "Ada Quill");
    // The newest documents carry Zoe: saying Ada is outdated there is true, and Prepare again must act on it.
    expect(page.outcomes().at(-1)).toBe("Saved. Prepare again to put it on your documents.");
    await until(() => visibleText(page).includes(changed), "the note on version 2");

    press(page, "detail-prepare");
    await until(() => all(page, ".version").length === 3, "version 3");
    expect(page.outcomes().at(-1)).toBe("Re-exported “Platform Lead · Fernwood” as version 3, with your new details.");
    expect(page.document.activeElement).toBe(button);
    expect(model.prompts).toHaveLength(1);
    await until(() => !visibleText(page).includes(changed), "the note to clear");
    const [v3] = all(page, ".version");
    expect(v3!.querySelector("h4")?.textContent).toBe("Version 3 · resume");
    expect(v3!.querySelector(".exports a")?.getAttribute("download")).toBe("Ada Quill - Resume - Fernwood Platform Lead.md");

    // Now the newest documents carry this name: already prepared, and nothing new.
    press(page, "detail-prepare");
    await until(() => page.outcomes().at(-1)?.startsWith("Already prepared") === true, "already prepared");
    expect(page.outcomes().at(-1)).toBe("Already prepared: “Platform Lead · Fernwood” matches version 3; nothing new.");
    expect(all(page, ".version")).toHaveLength(3);
    await page.quiet();
    expect(page.outcomes()).toEqual([
      "Saved. Prepare again to put it on your documents.",
      "Re-exported “Platform Lead · Fernwood” as version 2, with your new details.",
      "Saved. Prepare again to put it on your documents.",
      "Re-exported “Platform Lead · Fernwood” as version 3, with your new details.",
      "Already prepared: “Platform Lead · Fernwood” matches version 3; nothing new.",
    ]);
  });

  it("a re-export that a refresh sees in flight is announced once, as the re-export it was", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const page = await openPage(bridge);
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.querySelector(".version") !== null, "version 1");
    await saveName(page, "Zoe Quill");

    // Hold the re-export between its files and its record while the page refreshes: the list reads it running.
    const store = ApplicationsStore.prototype as unknown as { writeVersion(this: ApplicationsStore, taskId: string, record: unknown): Promise<void> };
    const writeVersion = store.writeVersion;
    let reached!: () => void;
    const atRecord = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    store.writeVersion = async function (this: ApplicationsStore, taskId: string, record: unknown) {
      reached();
      await released;
      return writeVersion.call(this, taskId, record);
    };
    try {
      press(page, "detail-prepare");
      await atRecord;
      page.refreshNow();
      await until(() => page.document.querySelector(".app-status")?.textContent === "Preparing now…", "the list to read it running");
    } finally {
      release();
      store.writeVersion = writeVersion;
    }
    await until(() => page.outcomes().some((line) => line.startsWith("Re-exported")), "the re-export");
    for (let refresh = 0; refresh < 2; refresh += 1) {
      page.refreshNow();
      await page.quiet();
    }
    expect(page.outcomes()).toEqual(["Saved. Prepare again to put it on your documents.", "Re-exported “Platform Lead · Fernwood” as version 2, with your new details."]);
  });
});

describe("Applications page: a re-export whose saved draft no longer passes (revision 2, X7)", () => {
  it("is refused in one plain line, and nothing new is listed", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const [task] = (await readdir(bridge.workspace.resolve("applications"))).filter((entry) => entry.endsWith(".json") && entry !== "details.json");
    const recordFile = bridge.workspace.resolve("applications", task!.replace(/\.json$/, ""), "versions", "v1.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    record.draft.resume.sections[1].statements[1] = "Shipped the on-call rotation tooling used by five engineering teams [C3].";
    await writeFile(recordFile, JSON.stringify(record));
    const page = await openPage(bridge);
    page.document.querySelector(".app-open")!.click();
    await until(() => page.document.querySelector(".version") !== null, "version 1");

    await saveName(page, "Zoe Quill");
    const button = press(page, "detail-prepare");
    await until(() => page.outcomes().at(-1)?.startsWith("Not re-exported") === true, "the refusal");
    expect(page.outcomes().at(-1)).toBe("Not re-exported: its saved sentences no longer pass the runner's checks.");
    expect(page.byId("last-action").className).toContain("refused");
    expect(page.document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    await page.quiet();
    expect(all(page, ".version")).toHaveLength(1);
  });
});

describe("Applications page: characters the PDF can't draw (revision 1, V16)", () => {
  it("warns at the name field and beside each PDF, naming the formats that keep them", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD), { details: false });
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const page = await openPage(bridge);
    page.type("details-name", "Ada Quill 李");
    page.byId("details-submit").focus();
    page.submit("details-form");
    const warning = "The PDF can't draw “李”, so it prints � in its place. The Markdown and Word files keep it.";
    await until(() => !page.byId("details-name-note").hidden, "the note at the name field");
    expect(page.byId("details-name-note").textContent).toBe(warning);
    expect(page.byId("details-name").getAttribute("aria-describedby")).toBe("details-name-error details-name-note");

    pressPrepare(page, jobId);
    await until(() => page.lines.includes("Prepared “Platform Lead · Fernwood”: version 1 is ready."), "the result", 10_000);
    await until(() => page.document.querySelector(".export-note") !== null, "the PDF note");
    const noted = all(page, ".exports li").filter((item) => item.querySelector(".export-note") !== null);
    expect(noted.map((item) => item.querySelector("a")?.textContent)).toEqual(["Resume, version 1 · PDF"]);
    expect(noted[0]!.querySelector(".export-note")?.textContent).toBe(warning);
    // A plain note, never amber.
    expect(all(page, ".decision")).toHaveLength(0);
    expect(all(page, ".badge.warn")).toHaveLength(0);
  });
});

describe("Applications page: watching (revision 1, V13)", () => {
  it("a page opened mid-preparation watches it and announces how it ended, once", async () => {
    const { bridge, model } = await bridgeAndModel(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    model.beforeTurn = () => held;
    const response = await bridge.request("/api/applications/prepare", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ jobId, coverLetter: false }) });
    expect(response.status).toBe(200);

    const page = await openPage(bridge);
    expect(page.document.querySelector(".app-status")?.textContent).toBe("Preparing now…");
    release();
    await waitForPreparationQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.outcomes().length > 0, "the outcome", 10_000);
    expect(page.outcomes()).toEqual(["Prepared “Platform Lead · Fernwood”: version 1 is ready."]);
    page.refreshNow();
    await sleep(300);
    expect(page.outcomes()).toHaveLength(1);
  });

  it("while a watched preparation can't be refreshed, says once that the runner can't be reached, and clears that on the next good refresh", async () => {
    const { bridge, model } = await bridgeAndModel(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    model.beforeTurn = () => held;
    let down = false;
    const page = await openPage(bridge, { intercept: (input) => (down && input.startsWith("/api/") ? Promise.reject(new TypeError("Failed to fetch")) : undefined) });
    pressPrepare(page, jobId);
    await until(() => page.lines.includes("Preparing “Platform Lead · Fernwood”…"), "the start");

    down = true;
    page.refreshNow();
    await until(() => page.lines.at(-1) === "Can't reach the runner. Is it still running?", "the notice");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      page.refreshNow();
      await sleep(300);
    }
    expect(page.lines.filter((line) => line === "Can't reach the runner. Is it still running?")).toHaveLength(1);
    expect(page.byId("last-action").className).toContain("refused");
    // "Before preparing" stops claiming the runner is running while it can't be reached.
    expect(page.byId("ready-runner").textContent).toBe("The runner can't be reached right now.");
    expect(page.byId("ready-runner").className).toBe("ready-blocked");

    down = false;
    page.refreshNow();
    await until(() => page.lines.at(-1) === "Still preparing “Platform Lead · Fernwood”…", "the notice to clear");
    await until(() => page.byId("ready-runner").textContent === "The runner's agent is running.", "the runner line to come back");
    expect(page.byId("ready-runner").className).toBe("ready-ok");
    release();
    await waitForPreparationQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.lines.at(-1) === "Prepared “Platform Lead · Fernwood”: version 1 is ready.", "the outcome", 10_000);
    expect(page.outcomes().filter((line) => line.startsWith("Prepared"))).toHaveLength(1);
  });
});

describe("Applications page: readiness in its own words (revision 1, V17, V18)", () => {
  it("an unreadable career-profile.md is named as code, once, with the Profile page to fix it", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    const profile = await new ProfileStore(bridge.workspace, bridge.clock).read();
    const md = bridge.workspace.resolve("career-profile.md");
    await writeFile(md, (await readFile(md, "utf8")).replace(` \`[${profile.boundaries[0]!.id}]\``, ""));
    const page = await openPage(bridge);
    const line = page.byId("ready-profile");
    expect(line.textContent).toBe("Your career-profile.md has an edit the runner can't read. Fix it on the Profile page first.");
    expect(line.querySelector("code")?.textContent).toBe("career-profile.md");
    expect(all(page, "#ready-profile a").map((link) => link.getAttribute("href"))).toEqual(["/ui/profile"]);
    pressPrepare(page, jobId);
    await until(() => page.outcomes().length > 0, "the refusal");
    expect(page.outcomes()).toEqual(["Not prepared: your career-profile.md has an edit the runner can't read."]);
    expect(page.byId("last-action").querySelector("code")?.textContent).toBe("career-profile.md");
  });

  it("a paused budget says so in its own words, with Settings and Runs as links", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    await pauseBudget(bridge.workspace, bridge.clock, "paused for this test");
    const page = await openPage(bridge);
    expect(page.byId("ready-runner").textContent).toBe("The run budget is paused, so nothing can be prepared. Resume it in Settings; the Runs page shows why it paused.");
    expect(all(page, "#ready-runner a").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Settings", "/ui/settings"],
      ["Runs", "/ui/runs"],
    ]);
  });

  it("a damaged application record that may be the job's refuses in one line that points to the file (revision 1, V7)", async () => {
    const bridge = await bridgeWith(honest(PLATFORM_LEAD));
    const { jobId } = await seedJob(bridge.workspace, bridge.clock, platformLeadJob());
    await prepareElsewhere(bridge, jobId);
    const [name] = (await readdir(bridge.workspace.resolve("applications"))).filter((entry) => entry.endsWith(".json") && entry !== "details.json");
    await writeFile(bridge.workspace.resolve("applications", name!), "{ not json");
    const page = await openPage(bridge);
    expect(page.byId("app-unreadable").textContent).toContain(`applications/${name}`);
    pressPrepare(page, jobId);
    await until(() => page.outcomes().length > 0, "the refusal");
    expect(page.outcomes()).toEqual(["Not prepared: a damaged application record may be this job's; see Applications below."]);
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
