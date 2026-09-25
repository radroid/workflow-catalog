import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import type { JobStructured } from "@workflow-catalog/contracts";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkExtractedJob } from "../agent/lib/extract-job-logic.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import capturesModule, { waitForExtractionQueue } from "../server/routes/captures.ts";
import { JobsStore } from "../store/jobs.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * P06.1: the Jobs page's follow-ups from P04's round-3 critic and P05's V13
 * and round-3 findings (`docs/spec/implementation/P06.1-jobs-and-status-followups.md`,
 * items 1.1-1.7). Duplicates the happy-dom harness from `jobs-page.test.ts`
 * (that file exports nothing, by the same convention `ui-pages.test.ts` set),
 * trimmed to what these tests need.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const MODULES: readonly LoadedRouteModule[] = [{ name: "captures", module: capturesModule }];
const realSetTimeout = globalThis.setTimeout;

interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly className: string;
  hidden: boolean;
  open: boolean;
  value: string;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  getElementById(id: string): DomNode | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  dispatchEvent(event: unknown): boolean;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
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
});

type Intercept = (input: string, init: { method?: string; body?: string }) => Promise<Response> | undefined;

interface Page {
  readonly document: DomDocument;
  readonly window: DomWindow;
  readonly lines: string[];
  readonly requests: string[];
  byId(id: string): DomNode;
  status(): string;
  type(id: string, text: string): void;
  submit(formId: string): void;
  rows(): number;
  setVisibility(state: "visible" | "hidden"): void;
  refreshNow(): void;
}

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function openJobsPage(bridge: TestBridge, options: { intercept?: Intercept } = {}): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/jobs`, width: 1280, height: 800 });
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(path.join(UI, "jobs.html"), "utf8");
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
  const MutationObserverCtor = (window as unknown as { MutationObserver: new (callback: () => void) => { observe(node: DomNode, options: Record<string, boolean>): void } }).MutationObserver;
  new MutationObserverCtor(() => {
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
    status: lineText,
    type: (id, text) => {
      const field = byId(id);
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    submit: (formId) => {
      byId(formId).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    rows: () => document.querySelectorAll(".job-row").length,
    setVisibility: (state) => {
      visibility = state;
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    refreshNow: () => page.setVisibility("visible"),
  };
  pages.push(page);
  vi.resetModules();
  await import(path.join(UI, "assets", "jobs.js"));
  await until(() => (document.getElementById("jobs-list")?.textContent ?? "").trim() !== "Loading…", "the jobs list to finish loading");
  return page;
}

async function realBridge(eve?: EveGateway): Promise<TestBridge> {
  return makeBridge({ modules: MODULES, eve });
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function openFirstJob(page: Page): Promise<void> {
  await until(() => page.rows() >= 1, "a job row");
  page.document.querySelector(".job-open")!.click();
  await until(() => page.document.activeElement?.id === "detail-title", "the detail to open");
}

// --- A scripted eve turn that calls the real extract_job check, one structured result per jobId ---

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };
const NORTHWIND_FIELDS: JobStructured = { title: "Staff Platform Engineer", company: "Northwind Labs", requirements: ["8+ years"] };

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Like jobs-page.test.ts's extractingEve, but the structured result can differ by jobId, for the two-jobs-settle-together test. */
function extractingEve(getStore: () => JobsStore, byJobId: (jobId: string) => JobStructured, held: Promise<void> = Promise.resolve()): EveGateway {
  const create = async ({ message }: { message: string }) => {
    const jobId = /jobId: "([0-9a-f-]{36})"/.exec(message)?.[1] ?? "";
    const revision = Number(/revision: (\d+)/.exec(message)?.[1] ?? "0");
    const output = await checkExtractedJob({ jobId, revision, structured: byJobId(jobId) }, getStore());
    await held;
    const events: MessageStreamEvent[] = [
      { type: "step.started", data: { modelId: "test-model", sequence: 0, stepIndex: 0, turnId: "t1" }, meta: META },
      { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "call-1", toolName: "extract_job", output }, sequence: 1, stepIndex: 0, turnId: "t1" }, meta: META } as MessageStreamEvent,
      { type: "turn.completed", data: { sequence: 2, turnId: "t1" }, meta: META },
      { type: "session.waiting", data: { continuationToken: "s1", wait: "next-user-message" }, meta: META },
    ];
    const response = { [Symbol.asyncIterator]: () => (async function* () { yield* events; })() } as unknown as MessageResponse;
    const session = { cancel: async () => ({ status: "accepted" as const, sessionId: "s1" }) } as unknown as ClientSession;
    return { response, session };
  };
  return { url: "http://127.0.0.1:3210", client: { sessions: { create } } as unknown as Client, health: async () => ({ ok: true }), modelId: async () => undefined, checkModel: async () => ({ ok: true }) };
}

async function bridgeExtracting(byJobId: (jobId: string) => JobStructured, held?: Promise<void>): Promise<{ bridge: TestBridge; store: JobsStore }> {
  const holder: { store?: JobsStore } = {};
  const bridge = await realBridge(extractingEve(() => holder.store!, byJobId, held));
  holder.store = new JobsStore(bridge.workspace);
  return { bridge, store: holder.store };
}

const CAPTURED_AT = "2026-09-22T09:00:00.000Z";

describe("Jobs page: the last file becomes unreadable while focus is on Re-extract (item 1.1)", () => {
  it("moves focus to the heading, then drops the stale section, instead of leaving it behind forever", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const job = await store.captureJob({ url: "https://jobs.example/ledgerkit-backend-engineer", text: "Backend Engineer at Ledgerkit.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    const retry = page.byId("detail-retry");
    retry.focus();
    expect(page.document.activeElement).toBe(retry);

    // The job's only file becomes unreadable behind the page's back (e.g. another process wrote it badly).
    await writeFile(path.join(bridge.workspace.root, "jobs", job.jobId, "snapshot-1.json"), "{ not valid json");
    page.refreshNow();
    await until(() => page.document.getElementById("detail-unreadable") !== null, "the unreadable section to appear");

    expect(page.document.activeElement?.id).toBe("detail-title"); // moved off the button, never left on body or a removed node
    expect(page.document.getElementById("detail-structured")).toBeNull(); // and the stale section was actually dropped
    expect(page.document.getElementById("detail-retry")).toBeNull();

    // A later, unrelated refresh (the data hasn't changed again) must not resurrect it or move focus again.
    const jobOpenButton = page.document.querySelector(".job-open")!;
    jobOpenButton.focus();
    page.refreshNow();
    await sleep(150);
    expect(page.document.getElementById("detail-structured")).toBeNull();
    expect(page.document.activeElement).toBe(jobOpenButton); // wherever the person moved focus to since, it's undisturbed
  });
});

describe("Jobs page: the same focus-redirect, for focus elsewhere in the detail (item 1.1, K4 round-1 revision)", () => {
  it("focus on the address link moves to the heading before the stale sections are dropped", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const job = await store.captureJob({ url: "https://jobs.example/ledgerkit-backend-engineer", text: "Backend Engineer at Ledgerkit.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    const link = page.document.querySelector("#detail-address a")!;
    link.focus();
    expect(page.document.activeElement).toBe(link);

    await writeFile(path.join(bridge.workspace.root, "jobs", job.jobId, "snapshot-1.json"), "{ not valid json");
    page.refreshNow();
    await until(() => page.document.getElementById("detail-unreadable") !== null, "the unreadable section to appear");

    expect(page.document.activeElement?.id).toBe("detail-title"); // K4: was previously only checked for #detail-structured
    expect(page.document.getElementById("detail-address")).toBeNull();
  });

  it("focus on the 'Full posting text' summary moves to the heading too, and a chmod'd directory does the same", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const job = await store.captureJob({ url: "https://jobs.example/ledgerkit-backend-engineer", text: "Backend Engineer at Ledgerkit.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    const summary = page.document.querySelector(".detail-raw summary")!;
    summary.focus();
    expect(page.document.activeElement).toBe(summary);

    await writeFile(path.join(bridge.workspace.root, "jobs", job.jobId, "snapshot-1.json"), "{ not valid json");
    page.refreshNow();
    await until(() => page.document.getElementById("detail-unreadable") !== null, "the unreadable section to appear");

    expect(page.document.activeElement?.id).toBe("detail-title");
    expect(page.document.querySelector(".detail-raw")).toBeNull();
  });
});

describe("Jobs page: the name cap cuts at a word (item 1.3)", () => {
  it("never cuts mid-word, however long the first line of the posting is", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    const longTitle = "Staff Platform Engineering Manager for Developer Experience and Internal Tooling at Northwind";
    page.type("paste-url", "https://jobs.example/northwind-labs/long-title");
    page.type("paste-text", `${longTitle}\nFictional posting.`);
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save outcome");
    await until(() => page.rows() === 1, "the job to appear in the list");
    const name = page.document.querySelector(".job-open")!.textContent!;
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith("…")).toBe(true); // the title alone is over 80 characters, so it is cut
    const prefix = name.slice(0, -1);
    expect(longTitle.startsWith(prefix)).toBe(true); // an exact, uninterrupted prefix of the real title
    expect(prefix.endsWith(" ")).toBe(false); // trimmed: no trailing space kept before the ellipsis
    const nextChar = longTitle[prefix.length];
    expect(nextChar === " " || nextChar === undefined).toBe(true); // the cut lands exactly where a word ends
    expect(prefix.length).toBeGreaterThan(60); // not an overly conservative cut
  });
});

describe("Jobs page: the name cap doesn't over-cut when the 80th character already ends a word (item 1.3, K3 round-1 revision)", () => {
  it("keeps the whole word that already fits exactly at the cut point, instead of dropping it to find an earlier space", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    // Built so index 79 (the 80th character) is itself a space: the first 79 characters are already whole words
    // that fit exactly and must survive in full -- the pre-fix code searched for the *last* space within its own
    // 79-character slice regardless, over-cutting "...of Platformxx" down to "...of" for no reason.
    const words = ["Senior", "Staff", "Principal", "Distinguished", "Software", "Engineering", "Manager", "of", "Platform"];
    let base = "";
    for (const word of words) {
      const next = base ? `${base} ${word}` : word;
      if (next.length > 79) break;
      base = next;
    }
    while (base.length < 79) base += "x"; // pads the last word itself -- never introduces a new space
    expect(base.length).toBe(79); // the fixture is built correctly before it's used to test anything
    const longTitle = `${base} Labs today, a truly excellent place to work indeed.`;
    expect(longTitle[79]).toBe(" "); // and it actually lands the boundary this test is about

    page.type("paste-url", "https://jobs.example/northwind-labs/word-boundary");
    page.type("paste-text", `${longTitle}\nFictional posting.`);
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save outcome");
    await until(() => page.rows() === 1, "the job to appear in the list");
    const name = page.document.querySelector(".job-open")!.textContent!;
    expect(name).toBe(`${base}…`); // the whole 79-character prefix survives -- nothing dropped to find an earlier space
  });
});

describe("Jobs page: one name for list and detail, and the toggle names its own revision (item 1.4)", () => {
  it("when the true latest revision is damaged, the detail uses the list's own url-path name, and the toggle says which revision it shows", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const first = await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood. Updated.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    await writeFile(path.join(bridge.workspace.root, "jobs", first.jobId, "snapshot-2.json"), "{ not valid json");
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    const listName = page.document.querySelector(".job-open")!.textContent;
    expect(listName).toBe("fernwood/data-engineer"); // T6's url-path fallback: the true latest (revision 2) is damaged

    await openFirstJob(page);
    expect(page.byId("detail-title").textContent).toBe(listName); // item 1.4: the same name, not revision 1's own title
    const summary = page.document.querySelector(".detail-raw summary")!;
    expect(summary.textContent).toBe("Full posting text (revision 1)"); // names the revision actually shown
  });
});

describe("Jobs page: the 'Last action' line uses the same name as the row and heading, for a job whose latest file is damaged (item 1.4, K6 round-1 revision)", () => {
  it("retrying the older readable revision announces the row/heading's name, not that revision's own content-derived name", async () => {
    const held = gate();
    const { bridge, store } = await bridgeExtracting(() => ({ title: "Data Platform Engineer", company: "Fernwood" }), held.opened);
    const first = await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood. Updated.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    await writeFile(path.join(bridge.workspace.root, "jobs", first.jobId, "snapshot-2.json"), "{ not valid json");

    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    const rowName = page.document.querySelector(".job-open")!.textContent!;
    expect(rowName).toBe("fernwood/data-engineer"); // T6's url-path fallback: the true latest (revision 2) is damaged

    await openFirstJob(page);
    expect(page.byId("detail-title").textContent).toBe(rowName);

    page.byId("detail-retry").click(); // retries revision 1, the newest readable one
    await until(() => page.status().startsWith("Extracting "), "the extraction to start");
    // K6: named the same way the row/heading are, not "Data Engineer at Fernwood." -- revision 1's own first-line
    // text, which is what a plain jobDisplayName(result.job) would have shown instead.
    expect(page.status()).toBe(`Extracting “${rowName}”…`);

    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.lines.some((line) => line.startsWith("Extracted ")), "the outcome", 6_000);
    const outcome = page.lines.filter((line) => line.startsWith("Extracted "));
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toBe(`Extracted “${rowName}”.`); // the settle path names it the same way too
  });
});

describe("Jobs page: the tag and the message are separated for assistive tech (item 1.5, P03.2's Q9 pattern)", () => {
  it("the whole live region reads 'Last action: Nothing yet.' on load, and reads separately after a done or a refused action", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    expect(page.byId("last-action").textContent).toBe("Last action: Nothing yet.");

    page.type("paste-url", "https://jobs.example/fernwood-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Fernwood.");
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save outcome");
    expect(page.byId("last-action").textContent).toBe(`Last action: ${page.status()}`);

    page.submit("paste-form"); // empty fields now: a refusal, whose tag is "Refused", not "Last action"
    expect(page.byId("last-action").textContent).toBe(`Refused: ${page.status()}`);
  });
});

describe("Jobs page: a repeated identical refusal (item 1.7, the pattern shared with the Applications page)", () => {
  it("clears both the tag and the message together before reapplying, never leaving the tag alone in between", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.byId("paste-submit").focus();
    page.submit("paste-form"); // empty address: "Not saved."
    await until(() => page.status() === "Not saved.", "the first refusal");
    expect(page.byId("last-action").querySelector(".tag")!.textContent).toBe("Refused");

    page.byId("paste-submit").focus(); // refuseField moved focus to paste-url; bring it back so the repeat is identical
    page.submit("paste-form"); // the identical refusal again: triggers lastAction's clear-then-reapply dance
    // Synchronously, before the animation frame that restores it: both the tag and the message are already clear,
    // so there is nothing for assistive tech to read as a bare "Refused" in between (the P06.1 item 1.7 fix).
    expect(page.byId("last-action").querySelector(".tag")!.textContent).toBe("");
    expect(page.status()).toBe("");

    await until(() => page.status() === "Not saved.", "the line restored a frame later");
    expect(page.byId("last-action").querySelector(".tag")!.textContent).toBe("Refused");
  });
});

describe("Jobs page: two extractions settling in the same refresh (item 1.2)", () => {
  it("announces both outcomes in one combined message, instead of the first being replaced before it's ever shown", async () => {
    const held = gate();
    const fields: Record<string, JobStructured> = {};
    const { bridge, store } = await bridgeExtracting((jobId) => fields[jobId] ?? {}, held.opened);
    const page = await openJobsPage(bridge);

    // Two fresh pastes, each a new job: a content-changing paste queues extraction and tracks it (afterSave), just
    // as an accepted Re-extract does, without needing to navigate between two open details. Each wait checks for
    // its own job's name, not just the "Saved " prefix both share: right after page.submit returns, the previous
    // save's own line is still showing (postJson's fetch hasn't resolved yet), so a prefix-only check would resolve
    // instantly against stale text instead of actually waiting for this save.
    page.type("paste-url", "https://jobs.example/harbor/support-engineer");
    page.type("paste-text", "Support Engineer at Harbor.");
    page.submit("paste-form");
    await until(() => page.status().includes("Support Engineer at Harbor"), "the first save");
    const harborId = (await store.findJobIdByUrl("https://jobs.example/harbor/support-engineer"))!;
    fields[harborId] = { title: "Support Engineer", company: "Harbor" };

    page.type("paste-url", "https://jobs.example/northwind-labs/staff-platform-engineer");
    page.type("paste-text", "Staff Platform Engineer at Northwind Labs.");
    page.submit("paste-form");
    // T18's line cap shortens this name before it's even extracted ("...at Northwind…"), so check a prefix short
    // enough to survive that, not the full sentence.
    await until(() => page.status().includes("Staff Platform Engineer at Northwind"), "the second save");
    const northwindId = (await store.findJobIdByUrl("https://jobs.example/northwind-labs/staff-platform-engineer"))!;
    fields[northwindId] = NORTHWIND_FIELDS;

    page.setVisibility("hidden"); // stop polling until both are fully settled on disk, so one refresh sees both together
    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.lines.some((line) => line.startsWith("Extracted ")), "the combined outcome", 6_000);

    const combined = page.lines.filter((line) => line.startsWith("Extracted "));
    expect(combined).toHaveLength(1); // one message, not the first silently replaced by the second
    // Both names fit evenly shortened to NAMED_LINE_MAX (T18); this is short enough that only the second is cut.
    // K3 (round-1 revision): the cut never leaves a dangling "·" in front of the ellipsis -- "Staff Platform
    // Engineer · Northwind Labs" loses its whole "· Northwind Labs" clause at this room, not just "Northwind Labs".
    expect(combined[0]).toBe("Extracted “Support Engineer · Harbor” and “Staff Platform Engineer…”.");
    expect(combined[0]!.length).toBeLessThanOrEqual(80);
  });
});

describe("Jobs page: two short-named extractions settling together (item 1.2, K3 round-1 revision)", () => {
  it("names each job once, even when every name is under 16 characters", async () => {
    // K3 (reviewer issue 3): settledMessage's room-fitting loop used to start at Math.max(...names), which can
    // itself be under 16 when every name is short -- skipping the loop body entirely and falling straight to the
    // nameless counted form ("2 jobs: 2 were extracted."), instead of naming both jobs as it does for longer ones.
    const held = gate();
    const fields: Record<string, JobStructured> = {};
    const { bridge, store } = await bridgeExtracting((jobId) => fields[jobId] ?? {}, held.opened);
    const page = await openJobsPage(bridge);

    page.type("paste-url", "https://jobs.example/quill/qa");
    page.type("paste-text", "QA at Quill.");
    page.submit("paste-form");
    await until(() => page.status().includes("QA at Quill"), "the first save");
    const quillId = (await store.findJobIdByUrl("https://jobs.example/quill/qa"))!;
    fields[quillId] = { title: "QA", company: "Quill" }; // "QA · Quill", 10 characters

    page.type("paste-url", "https://jobs.example/harbor/chef");
    page.type("paste-text", "Chef at Harbor.");
    page.submit("paste-form");
    await until(() => page.status().includes("Chef at Harbor"), "the second save");
    const harborId = (await store.findJobIdByUrl("https://jobs.example/harbor/chef"))!;
    fields[harborId] = { title: "Chef", company: "Harbor" }; // "Chef · Harbor", 13 characters

    page.setVisibility("hidden");
    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.lines.some((line) => line.startsWith("Extracted ")), "the combined outcome", 6_000);

    const combined = page.lines.filter((line) => line.startsWith("Extracted "));
    expect(combined).toHaveLength(1);
    expect(combined[0]).toBe("Extracted “QA · Quill” and “Chef · Harbor”."); // both named, never "2 jobs: 2 were extracted."
  });
});

describe("Jobs page: the runner going down while an extraction is watched (item 1.6, P05's V13 pattern)", () => {
  it("says once that the runner can't be reached, and clears that on the next good refresh", async () => {
    const held = gate();
    const { bridge, store } = await bridgeExtracting(() => NORTHWIND_FIELDS, held.opened);
    await store.captureJob({ url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    let down = false;
    const page = await openJobsPage(bridge, { intercept: (input, init) => (down && (init.method ?? "GET") === "GET" ? Promise.reject(new TypeError("fetch failed")) : undefined) });
    await openFirstJob(page);
    page.byId("detail-retry").click();
    await until(() => page.status().startsWith("Extracting "), "the extraction to start");

    down = true;
    page.refreshNow();
    await until(() => page.status() === "Can't reach the runner. Is it still running?", "the notice");
    expect(page.byId("last-action").className).toContain("refused");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      page.refreshNow();
      await sleep(150);
    }
    expect(page.lines.filter((line) => line === "Can't reach the runner. Is it still running?")).toHaveLength(1); // announced once, not on every failed poll

    // K2 (round-1 revision): the runner comes back while the watched extraction is STILL running (`held` hasn't
    // been opened yet) -- the notice must actually clear, and restore the "Extracting …" line, not sit stuck or
    // jump straight to an outcome that hasn't happened. A no-op clearUnreachable would leave the old notice text
    // on screen forever here, since nothing else calls lastAction until the extraction actually settles.
    down = false;
    page.refreshNow();
    await until(() => page.status() !== "Can't reach the runner. Is it still running?", "the notice to clear");
    expect(page.status()).toMatch(/^Extracting “.*”…$/); // restored, named, not left blank or on the bare placeholder
    expect(page.byId("last-action").className).toContain("working");

    // A second outage announces again -- proof the first clear genuinely reset the shown/cleared state, not just a
    // one-off coincidence (a permanently-latched "shown" flag would silently swallow this one).
    down = true;
    page.refreshNow();
    await until(() => page.lines.filter((line) => line === "Can't reach the runner. Is it still running?").length === 2, "a second notice");

    down = false;
    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.lines.some((line) => line.startsWith("Extracted “")), "the outcome once the runner is reachable again", 6_000);
    expect(page.lines.filter((line) => line.startsWith("Extracted “"))).toHaveLength(1);
    expect(page.lines.filter((line) => line === "Can't reach the runner. Is it still running?")).toHaveLength(2); // both outages were announced, the second one included
  });
});

describe("Jobs page: the runner is down from the very first load, with nothing started yet (item 1.6, K2 round-1 revision)", () => {
  it("a first-load refusal sets the same notice, and clears on the next good refresh", async () => {
    const bridge = await realBridge();
    let down = true;
    const page = await openJobsPage(bridge, { intercept: (input, init) => (down && (init.method ?? "GET") === "GET" ? Promise.reject(new TypeError("fetch failed")) : undefined) });
    await until(() => page.status() === "Can't reach the runner. Is it still running?", "the first-load notice");
    expect(page.byId("last-action").className).toContain("refused");

    down = false;
    page.refreshNow();
    await until(() => page.status() !== "Can't reach the runner. Is it still running?", "the notice to clear on the next good refresh");
    expect(page.status()).toBe("Reached the runner again."); // nothing was ever started, so this is the plain recovery line
    expect(page.byId("last-action").className).toContain("done");
  });

  it("a first-load 500 sets the same notice too, and also clears on the next good refresh", async () => {
    const bridge = await realBridge();
    let broken = true;
    const page = await openJobsPage(bridge, {
      intercept: (input, init) =>
        broken && (init.method ?? "GET") === "GET" && input === "/api/captures"
          ? jsonResponse(500, { ok: false, error: { code: "internal_error", message: "the runner hit a problem." } })
          : undefined,
    });
    await until(() => page.status() === "Couldn't load the saved jobs; reload the page to try again.", "the first-load 500 notice");
    expect(page.byId("last-action").className).toContain("refused");

    broken = false;
    page.refreshNow();
    await until(() => page.status() !== "Couldn't load the saved jobs; reload the page to try again.", "the notice to clear");
    expect(page.status()).toBe("Reached the runner again.");
  });
});

describe("Jobs page: a job directory that can't be read (item 2.2)", () => {
  it("lists it, names the folder, and its detail says the same, without crashing", async () => {
    const bridge = await realBridge();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const page = await openJobsPage(bridge, {
      intercept: (input, init) => {
        const method = init.method ?? "GET";
        if (method === "GET" && input === "/api/captures") {
          return jsonResponse(200, { jobs: [{ jobId, revisionCount: 0, latestRevision: 0, unreadable: [], directoryUnreadable: `jobs/${jobId}`, extraction: null }] });
        }
        if (method === "GET" && input === `/api/captures/${jobId}`) {
          return jsonResponse(200, { jobId, latestRevision: 0, revisions: [], extraction: [], unreadable: [], directoryUnreadable: `jobs/${jobId}` });
        }
        return undefined;
      },
    });
    await until(() => page.rows() === 1, "the unreadable job row");
    expect(page.document.querySelector(".job-open")!.textContent).toBe("A saved job that can't be read");
    expect(page.document.querySelector(".job-status.refused")!.textContent).toBe(`This job's folder can't be read: jobs/${jobId}`);
    // K7 (round-1 revision): the row never also claims "0 revisions" beside that -- there is no meta line at all,
    // since nothing about this job's revisions is actually known.
    expect(page.document.querySelector(".job-meta")).toBeNull();
    expect(page.document.querySelector(".job-row")!.textContent).not.toMatch(/revision/i);

    page.document.querySelector(".job-open")!.click();
    await until(() => page.document.activeElement?.id === "detail-title", "the detail to open");
    expect(page.byId("detail-title").textContent).toBe("A saved job that can't be read");
    expect(page.byId("detail-unreadable").textContent).toBe(`This job's folder can't be read: jobs/${jobId}.`);
  });
});
