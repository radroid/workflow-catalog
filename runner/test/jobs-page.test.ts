import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import type { JobStructured } from "@workflow-catalog/contracts";
import type { Client, ClientSession, MessageResponse, MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkExtractedJob } from "../agent/lib/extract-job-logic.ts";
import type { SafeFetchResult } from "../lib/safe-fetch.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import capturesModule, { captureAndExtract, createCapturesRouteModule, waitForExtractionQueue } from "../server/routes/captures.ts";
import { JobsStore } from "../store/jobs.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * The Jobs page's own script (`runner/ui/jobs.html` + `assets/jobs.js`), run
 * in a DOM against the real `/api/captures` routes: the same happy-dom
 * technique as `ui-pages.test.ts` (P03), duplicated rather than imported
 * because that file exports nothing.
 *
 * Covers the UI-critic rules this packet holds itself to: one live region
 * with each outcome announced once, in one short sentence (J5, T18); focus
 * never dropped, and a focused node never rebuilt (J4); aria-disabled while a
 * request is in flight; field errors only for what was typed (T14); a
 * refresh that keeps open sections open (T16); the page's own refresh loop,
 * which announces only what it started (T11); and no field name, status code
 * or id in visible text.
 *
 * The page's timers run on the test window's own clock, so closing the
 * window at the end of a test cancels them; the page is also sent to the
 * background first, which stops its refresh loop.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const MODULES: readonly LoadedRouteModule[] = [{ name: "captures", module: capturesModule }];
const realSetTimeout = globalThis.setTimeout;

// Just the DOM surface these tests touch: the runner's tsconfig has no DOM lib.
interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

afterEach(async () => {
  while (pages.length > 0) {
    const page = pages.pop()!;
    page.setVisibility("hidden"); // the page stops its refresh loop
    await sleep(50); // a request already in flight settles into the stopped loop
    await page.window.happyDOM.close();
  }
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

type Intercept = (input: string, init: { method?: string; body?: string }) => Promise<Response> | undefined;

interface Page {
  readonly document: DomDocument;
  readonly window: DomWindow;
  /** Every line text announced since the page loaded, in order (the first "Nothing yet." excluded). */
  readonly lines: string[];
  /** Every request the page made, as "METHOD /path". */
  readonly requests: string[];
  byId(id: string): DomNode;
  status(): string;
  type(id: string, text: string): void;
  submit(formId: string): void;
  rows(): number;
  setVisibility(state: "visible" | "hidden"): void;
  /** What a person switching back to the tab does: the page refreshes at once. */
  refreshNow(): void;
}

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Loads the Jobs page's HTML into a fresh DOM and runs its module against the bridge, as the browser would. */
async function openJobsPage(bridge: TestBridge, options: { intercept?: Intercept } = {}): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/jobs`, width: 1280, height: 800 });
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
  // The first refresh replaces #jobs-list's contents (success or error) once it settles; the static placeholder's
  // text (trimmed: the raw textContent carries the HTML source's indentation) is the one value it never puts back.
  await until(() => (document.getElementById("jobs-list")?.textContent ?? "").trim() !== "Loading…", "the jobs list to finish loading");
  return page;
}

async function realBridge(eve?: EveGateway, modules: readonly LoadedRouteModule[] = MODULES): Promise<TestBridge> {
  return makeBridge({ modules, eve });
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function openFirstJob(page: Page): Promise<void> {
  await until(() => page.rows() >= 1, "a job row");
  page.document.querySelector(".job-open")!.click();
  await until(() => page.document.activeElement?.id === "detail-title", "the detail to open");
}

// --- A scripted eve turn that calls the real extract_job check (round-2 T1) ---

const META = { at: "2026-09-22T09:00:00.000Z", id: "evt-0" };
const NORTHWIND_FIELDS: JobStructured = { title: "Staff Platform Engineer", company: "Northwind Labs", requirements: ["8+ years"] };

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function extractingEve(getStore: () => JobsStore, structured: JobStructured, held: Promise<void> = Promise.resolve()): EveGateway {
  const create = async ({ message }: { message: string }) => {
    const jobId = /jobId: "([0-9a-f-]{36})"/.exec(message)?.[1] ?? "";
    const revision = Number(/revision: (\d+)/.exec(message)?.[1] ?? "0");
    const output = await checkExtractedJob({ jobId, revision, structured }, getStore());
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

async function bridgeExtracting(structured: JobStructured, held?: Promise<void>): Promise<{ bridge: TestBridge; store: JobsStore }> {
  const holder: { store?: JobsStore } = {};
  const bridge = await realBridge(extractingEve(() => holder.store!, structured, held));
  holder.store = new JobsStore(bridge.workspace);
  return { bridge, store: holder.store };
}

const CAPTURED_AT = "2026-09-22T09:00:00.000Z";

describe("Jobs page: initial load", () => {
  it("shows the empty state when there are no jobs yet", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    expect(page.byId("jobs-empty").hidden).toBe(false);
    expect(page.byId("jobs-list").hidden).toBe(true);
  });
});

describe("Jobs page: paste form", () => {
  it("pastes a posting, announces success once naming the job, clears the form, and lists the new job (named from its own text, never a bare hostname)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "https://jobs.example/fernwood-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Fernwood\nFictional posting.");
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save outcome");
    expect(page.status()).toBe("Saved “Staff Software Engineer at Fernwood”; not extracted yet.");
    expect(page.byId("paste-url").value).toBe("");
    expect(page.byId("paste-text").value).toBe("");
    expect(page.byId("paste-submit").getAttribute("aria-disabled")).toBe("false");
    await until(() => page.rows() === 1, "the job to appear in the list");
    expect(page.document.querySelector(".job-open")!.textContent).toContain("Staff Software Engineer at Fernwood");
    expect(page.lines.filter((line) => line.startsWith("Saved "))).toHaveLength(1);
  });

  it("a refused paste keeps the typed text, leaves the button enabled, marks the field invalid, and never shows a field name", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "javascript:alert(1)");
    page.type("paste-text", "Some posting text.");
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved."); // focus moved to the field, whose description carries the detail (J4)
    const fieldError = page.byId("paste-url-error").textContent ?? "";
    expect(fieldError).toBe("Use the posting's web address, starting with https:// or http://.");
    expect(fieldError).not.toMatch(/\burl\b/i);
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBe("true");
    expect(page.document.activeElement?.id).toBe("paste-url");
    expect(page.byId("paste-url").value).toBe("javascript:alert(1)");
    expect(page.byId("paste-text").value).toBe("Some posting text.");
    expect(page.byId("paste-submit").getAttribute("aria-disabled")).toBe("false");
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]); // refused before sending (T19)
  });

  it("an empty paste and an empty URL each get their own field message, and the field clears once the person edits it again", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("paste-url-error").textContent).toBe("Enter the posting's address.");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("paste-text-error").hidden).toBe(true); // checked the address first; the text was never reached

    page.type("paste-url", "https://jobs.example/posting");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBeNull(); // typing clears the field's own error
    page.byId("paste-submit").focus();
    page.submit("paste-form");
    expect(page.byId("paste-text-error").textContent).toBe("Paste the posting's text.");
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses an over-size paste before ever sending it", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "https://jobs.example/huge-posting");
    page.type("paste-text", "x".repeat(200_001));
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("paste-text-error").textContent).toBe("This posting is over 200 KB. Paste a shorter excerpt instead.");
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBe("true");
    expect(page.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
  });

  it("measures the paste the contract's way: 195,000 bytes with 5,000 newlines is over 200 KB as JSON, and is refused on the text field (T13)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    const text = "x".repeat(190_000) + "\n".repeat(5_000);
    expect(new TextEncoder().encode(text).length).toBe(195_000);
    page.type("paste-url", "https://jobs.example/many-newlines");
    page.type("paste-text", text);
    page.submit("paste-form");
    expect(page.byId("paste-text-error").textContent).toBe("This posting is over 200 KB. Paste a shorter excerpt instead.");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBeNull();
    expect(page.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
  });

  it("a too-large refusal from the runner lands on the text field, never the address (T13)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge, {
      intercept: (input, init) => (init.method === "POST" && input === "/api/captures/paste" ? jsonResponse(413, { ok: false, error: { code: "body_too_large", message: "Request body is larger than 262144 bytes." } }) : undefined),
    });
    page.type("paste-url", "https://jobs.example/posting");
    page.type("paste-text", "Staff Software Engineer at Fernwood.");
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    expect(page.byId("paste-text-error").textContent).toBe("This posting is over 200 KB. Paste a shorter excerpt instead.");
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBeNull();
  });

  it("an unchanged paste says nothing was duplicated, naming the revision it matches", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/quill-devops", text: "DevOps Engineer at Quill.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    page.type("paste-url", "https://jobs.example/quill-devops");
    page.type("paste-text", "DevOps Engineer at Quill.");
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the duplicate outcome");
    expect(page.status()).toBe("Already saved: this posting hasn't changed since revision 1, so nothing was duplicated.");
  });
});

describe("Jobs page: field errors (J4, J6.3, T14)", () => {
  it("Enter in the empty address field keeps focus there, and the line carries the reason", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.byId("paste-url").focus();
    page.submit("paste-form"); // what Enter in the field does
    expect(page.status()).toBe("Not saved: the address is empty.");
    expect(page.document.activeElement?.id).toBe("paste-url");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("paste-url-error").textContent).toBe("Enter the posting's address.");
  });

  it("from the button, focus moves to the refused field and the line says only “Not saved.”", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "https://jobs.example/posting");
    page.byId("paste-submit").focus();
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.document.activeElement?.id).toBe("paste-text");
  });

  it("“Can't reach the runner” goes in the line only, never on a field", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge, { intercept: (_input, init) => (init.method === "POST" ? Promise.reject(new TypeError("fetch failed")) : undefined) });
    page.type("paste-url", "https://jobs.example/posting");
    page.type("paste-text", "Staff Software Engineer at Fernwood.");
    page.byId("paste-submit").focus();
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    expect(page.status()).toBe("Can't reach the runner. Is it still running?");
    for (const id of ["paste-url", "paste-text", "url-input"]) {
      expect(page.byId(id).getAttribute("aria-invalid")).toBeNull();
      expect(page.byId(`${id}-error`).hidden).toBe(true);
    }
    expect(page.document.activeElement?.id).toBe("paste-submit");
    expect(page.byId("paste-text").value).toBe("Staff Software Engineer at Fernwood.");
  });

  it("a server error goes in the line only, never on a field", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge, {
      intercept: (input, init) => (init.method === "POST" && input === "/api/captures/paste" ? jsonResponse(500, { ok: false, error: { code: "internal_error", message: "boom" } }) : undefined),
    });
    page.type("paste-url", "https://jobs.example/posting");
    page.type("paste-text", "Staff Software Engineer at Fernwood.");
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    expect(page.status()).toBe("Not saved: the runner hit a problem; try again.");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBeNull();
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBeNull();
  });

  it("a page that couldn't be fetched goes in the line only: the address itself was fine", async () => {
    const fakeFetchUrl = async (): Promise<SafeFetchResult> => ({ ok: false, reason: "timeout", message: "The page didn't finish loading within 10 s." });
    const bridge = await realBridge(undefined, [{ name: "captures", module: createCapturesRouteModule(fakeFetchUrl) }]);
    const page = await openJobsPage(bridge);
    page.type("url-input", "https://jobs.example/slow-page");
    page.byId("url-submit").focus();
    page.submit("url-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    expect(page.status()).toBe("Not saved: the page took too long to answer.");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBeNull();
    expect(page.byId("url-input").value).toBe("https://jobs.example/slow-page");
  });

  it("a field error clears when a later, unrelated action succeeds", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("url-input", "javascript:alert(1)");
    page.submit("url-form");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");

    page.type("paste-url", "https://jobs.example/fernwood-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Fernwood.");
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBeNull();
    expect(page.byId("url-input-error").hidden).toBe(true);
  });

  it("the paste form's address gets the fetch form's scheme check, with its own wording (T19)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "file:///etc/passwd");
    page.type("paste-text", "Some posting text.");
    page.submit("paste-form");
    expect(page.byId("paste-url-error").textContent).toBe("Use the posting's web address, starting with https:// or http://.");
    expect(page.byId("paste-url-error").querySelectorAll("code").length).toBe(2);
    page.type("paste-url", "not a web address");
    page.submit("paste-form");
    expect(page.byId("paste-url-error").textContent).toBe("That doesn't look like a web address.");
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]);
  });
});

describe("Jobs page: URL-fetch form", () => {
  it("refuses a plain http:// link before ever fetching, with a friendly message on the field (mutation target: 'accept http on the fetch path')", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("url-input", "http://jobs.example/posting");
    page.submit("url-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("url-input-error").textContent).toBe("The runner only fetches https:// links. Paste the posting text instead for an http:// page.");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("url-input").value).toBe("http://jobs.example/posting");
    expect(page.byId("url-submit").getAttribute("aria-disabled")).toBe("false");
  });

  it("refuses a javascript: link client-side, without the http:-specific 'paste instead' sentence", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("url-input", "javascript:alert(1)");
    page.submit("url-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("url-input-error").textContent).toBe("The runner only fetches https:// links.");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");
  });

  it("an empty URL gets its own message, distinct from the paste form's", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.submit("url-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("url-input-error").textContent).toBe("Enter the page's address.");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Jobs page: detail, revisions and the posting-changed diff", () => {
  it("opens a job (moving focus to the detail heading), shows both revisions, and the diff between them, every line in the same text column (T19)", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nRemote friendly.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nOnsite in Fernwood.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    expect(page.byId("detail-section").hidden).toBe(false);
    expect(page.document.querySelectorAll(".revision-card").length).toBe(2);

    const details = page.document.querySelector(".revision-diff")!;
    details.open = true;
    details.dispatchEvent(new page.window.Event("toggle"));
    await until(() => page.document.querySelectorAll(".diff-line").length > 0, "the diff to render");
    // The visible line lives in .diff-text; .diff-line's own textContent also carries the visually hidden prefix.
    const added = Array.from(page.document.querySelectorAll(".diff-line.added .diff-text")).map((node) => node.textContent);
    const removed = Array.from(page.document.querySelectorAll(".diff-line.removed .diff-text")).map((node) => node.textContent);
    expect(removed).toEqual(["Remote friendly."]);
    expect(added).toEqual(["Onsite in Fernwood."]);
    expect(page.document.querySelector(".diff-line.removed")!.textContent).toContain("Removed:");
    expect(page.document.querySelector(".diff-line.added")!.textContent).toContain("Added:");
    // T19: every line, unchanged ones included, has its one marker cell, so the text column lines up.
    for (const line of Array.from(page.document.querySelectorAll(".diff-line"))) expect(line.querySelectorAll(".diff-marker").length).toBe(1);
    expect(page.document.querySelector(".diff-line.same .diff-marker")!.textContent).toBe("");
    expect(page.document.querySelector(".diff-line.same .diff-marker")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("a paste that revises an already-open job refreshes its detail without stealing focus from the paste button", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/quill-staff-swe", text: "Staff Software Engineer at Quill.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    expect(page.document.querySelectorAll(".revision-card").length).toBe(1);

    const submit = page.byId("paste-submit");
    submit.focus();
    page.type("paste-url", "https://jobs.example/quill-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Quill. Updated posting.");
    page.submit("paste-form");
    await until(() => page.status().includes("as revision 2"), "the second save");
    expect(page.document.activeElement).toBe(submit); // focus stayed on the button actually used
    await until(() => page.document.querySelectorAll(".revision-card").length === 2, "the open detail to pick up the new revision");
  });

  it("Try extracting again is aria-disabled while busy, keeps focus on itself, and puts the reason in the detail, not the line", async () => {
    const bridge = await realBridge(); // no eve: nothing can be extracted
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/ledgerkit-backend-engineer", text: "Backend Engineer at Ledgerkit.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);

    const retry = page.byId("detail-retry");
    expect(retry.textContent).toBe("Try extracting again");
    retry.click();
    await until(() => page.status().startsWith("Couldn't extract"), "the retry outcome");
    expect(page.status()).toBe("Couldn't extract “Backend Engineer at Ledgerkit.”; its details say why.");
    await until(() => page.document.getElementById("detail-extraction-message") !== null, "the reason in the detail");
    expect(page.byId("detail-extraction-message").textContent).toBe("The runner isn't running, so this can't be extracted yet. Start it with npm run runner, then try again.");
    expect(page.byId("detail-extraction-message").querySelector("code")!.textContent).toBe("npm run runner");
    // J4: the pressed button keeps focus, and morphChildren reuses this same node across the re-render.
    expect(page.document.activeElement).toBe(retry);
    expect(retry.isConnected).toBe(true);
    expect(retry.getAttribute("aria-disabled")).toBe("false"); // not_run is a settled state
    expect(retry.textContent).toBe("Try extracting again"); // no fields, so not "Re-extract"
  });

  it("names an unextracted job from its own text, never the bare hostname, even when several jobs share a host", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/posting-a", text: "Support Engineer at Harbor.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/posting-b", text: "Data Analyst at Ledgerkit.", extractorVersion: "t", capturedAt: "2026-09-22T09:05:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 2, "both job rows");
    const names = Array.from(page.document.querySelectorAll(".job-open")).map((node) => node.textContent);
    expect(names).toEqual(["Data Analyst at Ledgerkit.", "Support Engineer at Harbor."]);
  });

  it("falls back to the URL's path, never the bare hostname, when the posting has no readable first line", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/careers/staff-recruiter", text: "   \n   ", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    expect(page.document.querySelector(".job-open")!.textContent).toBe("careers/staff-recruiter");
  });

  it("the full posting text is a focusable, labelled region (T17)", async () => {
    const bridge = await realBridge();
    await new JobsStore(bridge.workspace).captureJob({ url: "https://jobs.example/quill-staff-swe", text: "Staff Software Engineer at Quill.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    const region = page.document.querySelector(".detail-raw .posting-text")!;
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Full posting text, revision 1");
    expect(region.textContent).toBe("Staff Software Engineer at Quill.");
  });

  it("a refresh keeps the open diff and the full posting text open, and the focused toggle keeps focus (T16)", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const first = await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nRemote friendly.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nOnsite in Fernwood.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);

    const diff = page.document.querySelector(".revision-diff")!;
    diff.open = true;
    diff.dispatchEvent(new page.window.Event("toggle"));
    await until(() => diff.querySelectorAll(".diff-line").length > 0, "the diff to render");
    const raw = page.document.querySelector(".detail-raw")!;
    raw.open = true;
    const summary = raw.querySelector("summary")!;
    summary.focus();

    // The extraction finishes in the background: fields appear above the open sections.
    await store.recordStructured(first.jobId, 2, { title: "Platform Engineer", company: "Harbor" });
    await store.setExtractionState(first.jobId, 2, { status: "done", updatedAt: "2026-09-23T09:00:05.000Z" });
    page.refreshNow();
    await until(() => page.document.querySelector(".detail-structured .structured-fields") !== null, "the new fields to show");

    expect(page.document.querySelector(".revision-diff")).toBe(diff);
    expect(diff.open).toBe(true);
    expect(diff.querySelectorAll(".diff-line").length).toBeGreaterThan(0);
    expect(page.document.querySelector(".detail-raw")).toBe(raw);
    expect(raw.open).toBe(true);
    expect(page.document.activeElement).toBe(summary);
    expect(summary.isConnected).toBe(true);
    expect(page.lines).toEqual([]); // not started on this page: nothing announced
  });
});

describe("Jobs page: extraction wording (T12)", () => {
  async function openWithState(extractorVersion: string, state: { status: "not_run" | "failed"; reason: string }): Promise<Page> {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const job = await store.captureJob({ url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion, capturedAt: CAPTURED_AT });
    await store.setExtractionState(job.jobId, 1, { ...state, updatedAt: "2026-09-22T09:00:01.000Z" } as never);
    const page = await openJobsPage(bridge);
    await openFirstJob(page);
    return page;
  }

  it("no model: the runner's own wording, with the command and folder in code", async () => {
    const page = await openWithState("extractor@1.0.0", { status: "not_run", reason: "no_model" });
    const message = page.byId("detail-extraction-message");
    expect(message.textContent).toBe("No model is configured. Run npm run setup in runner/, then try again.");
    expect(Array.from(message.querySelectorAll("code")).map((node) => node.textContent)).toEqual(["npm run setup", "runner/"]);
  });

  it("a paused budget says so, and points to Resume in Settings", async () => {
    const page = await openWithState("extractor@1.0.0", { status: "not_run", reason: "budget_paused" });
    const message = page.byId("detail-extraction-message");
    expect(message.textContent).toBe("The budget is paused, so nothing was extracted. Resume it in Settings, then try again.");
    const link = message.querySelector("a")!;
    expect(link.textContent).toBe("Settings");
    expect(link.getAttribute("href")).toBe("/ui/settings#budget-section");
  });

  it("a pasted job never offers “paste the text directly”; a captured one does", async () => {
    const pasted = await openWithState("paste@1", { status: "failed", reason: "no_fields_found" });
    expect(pasted.byId("detail-extraction-message").textContent).toBe("The runner didn't find any fields in this posting. Try again.");
    const captured = await openWithState("extractor@1.0.0", { status: "failed", reason: "no_fields_found" });
    expect(captured.byId("detail-extraction-message").textContent).toBe("The runner didn't find any fields in this posting. Try again, or paste the text directly.");
  });
});

describe("Jobs page: damaged files are named, never hidden (T6)", () => {
  it("a job whose latest revision can't be read stays in the list by its address, with the file's path in code", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const first = await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await store.captureJob({ url: "https://jobs.example/fernwood/data-engineer", text: "Data Engineer at Fernwood. Updated.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    await writeFile(path.join(bridge.workspace.root, "jobs", first.jobId, "snapshot-2.json"), "{ not valid json");
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    expect(page.document.querySelector(".job-open")!.textContent).toBe("fernwood/data-engineer");
    expect(page.document.querySelector(".job-status.refused code")!.textContent).toBe(`jobs/${first.jobId}/snapshot-2.json`);

    await openFirstJob(page);
    expect(page.byId("detail-unreadable").querySelector("code")!.textContent).toBe(`jobs/${first.jobId}/snapshot-2.json`);
    expect(page.document.querySelectorAll(".revision-card").length).toBe(1);
    expect(page.lines).toEqual([]); // nothing failed: the page simply names the file
  });

  it("a job none of whose revisions can be read still lists, and opens", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    const job = await store.captureJob({ url: "https://jobs.example/harbor/only", text: "Harbor posting.", extractorVersion: "t", capturedAt: CAPTURED_AT });
    await writeFile(path.join(bridge.workspace.root, "jobs", job.jobId, "snapshot-1.json"), JSON.stringify({ not: "a snapshot" }));
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    expect(page.document.querySelector(".job-open")!.textContent).toBe("A saved job that can't be read");
    await openFirstJob(page);
    expect(page.byId("detail-title").textContent).toBe("A saved job that can't be read");
    expect(page.byId("detail-unreadable").querySelector("code")!.textContent).toBe(`jobs/${job.jobId}/snapshot-1.json`);
    expect(page.document.getElementById("detail-retry")).toBeNull();
  });
});

describe("Jobs page: extraction in the background (T11)", () => {
  it("an accepted Try extracting again says “Extracting …” at once, shows the job as running, and announces its result exactly once", async () => {
    const held = gate();
    const { bridge, store } = await bridgeExtracting(NORTHWIND_FIELDS, held.opened);
    await store.captureJob({ url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await openFirstJob(page);

    const retry = page.byId("detail-retry");
    retry.click();
    await until(() => page.status().startsWith("Extracting “"), "the line to say the extraction started");
    expect(page.status()).toBe("Extracting “Staff Platform Engineer at Northwind Labs.”…");
    expect(page.byId("last-action").querySelector(".tag")!.textContent).toBe("Working");
    const running = ["Extracting in the background…", "Waiting to extract…"];
    await until(() => running.includes(page.document.getElementById("detail-extraction-message")?.textContent ?? ""), "the job to show as running");
    expect(["Extracting…", "Waiting to extract…"]).toContain(page.document.querySelector(".job-status")?.textContent);
    expect(retry.getAttribute("aria-disabled")).toBe("true");

    held.open();
    const done = "Extracted “Staff Platform Engineer · Northwind Labs”.";
    await until(() => page.status() === done, "the result, on the page's own 2 s refresh", 6_000);
    expect(retry.getAttribute("aria-disabled")).toBe("false");
    expect(retry.textContent).toBe("Re-extract");
    expect(page.document.activeElement).toBe(retry);
    page.refreshNow();
    await sleep(150);
    page.refreshNow();
    await sleep(150);
    expect(page.lines.filter((line) => line === done)).toHaveLength(1);
  });

  it("a job the page didn't start is watched and updated in place, with no announcement", async () => {
    const held = gate();
    const { bridge } = await bridgeExtracting(NORTHWIND_FIELDS, held.opened);
    await captureAndExtract(bridge.ctx, { url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge);
    await until(() => page.rows() === 1, "the job row");
    const row = page.document.querySelector(".job-row")!;
    await until(() => ["Extracting…", "Waiting to extract…"].includes(page.document.querySelector(".job-status")?.textContent ?? ""), "the row to show the extraction");

    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
    page.refreshNow();
    await until(() => page.document.querySelector(".job-open")?.textContent === "Staff Platform Engineer · Northwind Labs", "the row to update");
    expect(page.document.querySelector(".job-row")).toBe(row); // in place, not rebuilt
    expect(page.document.querySelector(".job-status")).toBeNull();
    expect(page.lines).toEqual([]);
    expect(page.status()).toBe("Nothing yet.");
  });

  it("the open job's row never disagrees with its detail: the detail, read after the list, wins", async () => {
    const held = gate();
    const { bridge, store } = await bridgeExtracting(NORTHWIND_FIELDS, held.opened);
    const { capture } = await captureAndExtract(bridge.ctx, { url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    for (let tries = 0; ((await store.getExtractionState(capture.jobId, 1)) as { status?: string } | undefined)?.status !== "running"; tries += 1) {
      if (tries > 200) throw new Error("the turn never started");
      await sleep(10);
    }
    // Every list read is a moment older than the detail read that follows it: here, from just before the turn started.
    const page = await openJobsPage(bridge, {
      intercept: (input, init) => {
        if ((init.method ?? "GET") !== "GET" || input !== "/api/captures") return undefined;
        return bridge.request(input, { headers: { cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } }).then(async (response) => {
          const body = (await response.json()) as { jobs: Array<{ extraction: unknown }> };
          for (const job of body.jobs) job.extraction = { status: "waiting", updatedAt: CAPTURED_AT };
          return jsonResponse(200, body);
        });
      },
    });
    await until(() => page.document.querySelector(".job-status")?.textContent === "Waiting to extract…", "the list's older read");
    await openFirstJob(page);
    expect(page.byId("detail-extraction-message").textContent).toBe("Extracting in the background…");
    expect(page.document.querySelector(".job-status")?.textContent).toBe("Extracting…");
    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
  });

  it("a new extension capture joins the list on the page's own 5 s refresh, with no announcement", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    expect(page.byId("jobs-empty").hidden).toBe(false);
    await new JobsStore(bridge.workspace).captureJob({ url: "https://jobs.example/quill/designer", text: "Product Designer at Quill.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    await until(() => page.rows() === 1, "the capture to join the list", 7_000);
    expect(page.lines).toEqual([]);
  });

  it("refreshes only while the page is visible, and at once when it becomes visible again", async () => {
    const held = gate();
    const { bridge } = await bridgeExtracting(NORTHWIND_FIELDS, held.opened);
    await captureAndExtract(bridge.ctx, { url: "https://jobs.example/northwind-labs/staff-platform-engineer", text: "Staff Platform Engineer at Northwind Labs.", extractorVersion: "extractor@1.0.0", capturedAt: CAPTURED_AT });
    const page = await openJobsPage(bridge); // a running extraction: visible, the page would refresh every 2 s
    page.setVisibility("hidden");
    await sleep(200); // a refresh already in flight settles
    const before = page.requests.length;
    await sleep(2_600);
    expect(page.requests.length).toBe(before);
    page.setVisibility("visible");
    await until(() => page.requests.length > before, "a refresh as soon as the page is visible", 1_000);
    held.open();
    await waitForExtractionQueue(bridge.workspace.root);
  });
});

describe("Jobs page: the line (J5, T18)", () => {
  it("every line message is one sentence of 90 characters or fewer, and 80 or fewer when it names a job, however long the name", async () => {
    const bridge = await realBridge(); // no eve: saves are not extracted
    const page = await openJobsPage(bridge);
    const longTitle = "Senior Staff Platform Engineer, Developer Experience and Internal Tooling, at Northwind Labs in Fernwood";
    page.type("paste-url", "https://jobs.example/northwind-labs/long-title");
    page.type("paste-text", `${longTitle}\nFictional posting.`);
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the first save");
    page.type("paste-url", "https://jobs.example/northwind-labs/long-title");
    page.type("paste-text", `${longTitle}\nFictional posting, revised.`);
    page.submit("paste-form");
    await until(() => page.status().includes("as revision 2"), "the second save");
    await openFirstJob(page);
    page.byId("detail-retry").click();
    await until(() => page.status().startsWith("Couldn't extract"), "the retry outcome");
    page.submit("url-form");
    await until(() => page.lines.at(-1) === "Not saved.", "the refusal to be recorded");

    expect(page.lines.length).toBeGreaterThanOrEqual(4);
    expect(page.lines.filter((line) => line.includes("“")).length).toBeGreaterThanOrEqual(3);
    for (const line of page.lines) {
      expect(line.length, line).toBeLessThanOrEqual(line.includes("“") ? 80 : 90); // measured to fit two lines at 390 px
      expect(line.replace(/“[^”]*”/g, "“”"), line).not.toMatch(/[.!?] [A-Z]/); // one sentence (a quoted name is data)
    }
  });
});
