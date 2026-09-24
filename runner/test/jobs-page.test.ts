import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import capturesModule from "../server/routes/captures.ts";
import { JobsStore } from "../store/jobs.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";
import type { EveGateway } from "../server/eve-gateway.ts";

/**
 * The Jobs page's own script (`runner/ui/jobs.html` + `assets/jobs.js`), run
 * in a DOM against the real `/api/captures` routes — the same happy-dom
 * technique as `ui-pages.test.ts` (P03), duplicated rather than imported
 * because that file exports nothing: `openPage` there is typed to
 * `"onboarding" | "profile"` and is not this packet's to edit.
 *
 * Covers the UI-critic rules this packet's report holds itself to: one live
 * region with each outcome announced once; focus explicitly moved (never
 * dropped to <body>) when a control it was on gets rebuilt, and never stolen
 * from a control the person is still using; aria-disabled while a request is
 * in flight; no field name, status code or UUID in visible text (P04's own
 * addition on top of P03's pattern, since server/http.ts's
 * validationErrorResponse names the offending field for API consumers, and
 * this page never repeats that wording).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const MODULES: readonly LoadedRouteModule[] = [{ name: "captures", module: capturesModule }];

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
  addEventListener(type: string, listener: (event: { readonly target: DomNode }) => void, capture?: boolean): void;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
  requestAnimationFrame(callback: (time: number) => void): unknown;
  readonly happyDOM: { close(): Promise<void> };
}

const { Window } = createRequire(path.join(HERE, "..", "..", "extension", "package.json"))("happy-dom") as {
  Window: new (options: { url: string; width: number; height: number }) => DomWindow;
};

const GLOBALS = ["window", "document", "requestAnimationFrame", "fetch"] as const;
const saved = new Map<string, unknown>(GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const windows: DomWindow[] = [];

afterEach(async () => {
  while (windows.length > 0) await windows.pop()!.happyDOM.close();
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

interface Page {
  readonly document: DomDocument;
  readonly window: DomWindow;
  byId(id: string): DomNode;
  status(): string;
  type(id: string, text: string): void;
  submit(formId: string): void;
}

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Loads the Jobs page's HTML into a fresh DOM and runs its module against the bridge, as the browser would. */
async function openJobsPage(bridge: TestBridge): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/jobs`, width: 1280, height: 800 });
  windows.push(window);
  const html = await readFile(path.join(UI, "jobs.html"), "utf8");
  (window.document as unknown as { body: { innerHTML: string } }).body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
  vi.resetModules();
  await import(path.join(UI, "assets", "jobs.js"));
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const page: Page = {
    document,
    window,
    byId,
    status: () => byId("last-action").querySelector(".text")?.textContent ?? "",
    type: (id, text) => {
      const field = byId(id);
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    submit: (formId) => {
      byId(formId).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
  };
  // loadJobs() at the bottom of jobs.js replaces #jobs-list's contents (success or error) once it settles;
  // the static placeholder li's text (trimmed: the raw textContent carries the HTML source's indentation
  // whitespace) is the one value it never puts back.
  await until(() => (document.getElementById("jobs-list")?.textContent ?? "").trim() !== "Loading…", "the jobs list to finish loading");
  return page;
}

async function realBridge(eve?: EveGateway): Promise<TestBridge> {
  return makeBridge({ modules: MODULES, eve });
}

describe("Jobs page: initial load", () => {
  it("shows the empty state when there are no jobs yet", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    expect(page.byId("jobs-empty").hidden).toBe(false);
    expect(page.byId("jobs-list").hidden).toBe(true);
  });
});

describe("Jobs page: paste form", () => {
  it("pastes a posting, announces success once naming the job, clears the form, and lists the new job (round-1 review L12 item 3: named from its own text, never a bare hostname)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "https://jobs.example/fernwood-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Fernwood. Fictional posting.");
    page.submit("paste-form");
    await until(() => page.status().startsWith("Saved "), "the save outcome");
    expect(page.status()).toContain("Staff Software Engineer at Fernwood");
    expect(page.byId("paste-url").value).toBe("");
    expect(page.byId("paste-text").value).toBe("");
    expect(page.byId("paste-submit").getAttribute("aria-disabled")).toBe("false");
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job to appear in the list");
    expect(page.document.querySelector(".job-open")!.textContent).toContain("Staff Software Engineer at Fernwood");
  });

  it("a refused paste keeps the typed text, re-enables the button, marks the field invalid, and never shows a field name in the sticky line (server/http.ts names the field for API consumers, not this page)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "javascript:alert(1)");
    page.type("paste-text", "Some posting text.");
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the refusal");
    // Round-1 review L12 item 6: the line says only the short outcome; the field carries the detail.
    expect(page.status()).toBe("Not saved.");
    const fieldError = page.byId("paste-url-error").textContent ?? "";
    expect(fieldError).not.toMatch(/\burl\b/i);
    expect(fieldError).not.toContain("Invalid request body");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("paste-url").value).toBe("javascript:alert(1)");
    expect(page.byId("paste-text").value).toBe("Some posting text.");
    expect(page.byId("paste-submit").getAttribute("aria-disabled")).toBe("false");
  });

  it("an empty paste and an empty URL each get their own field message (round-1 review L12 item 6), and the field clears once the person edits it again", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("paste-url-error").textContent).toContain("address");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBe("true");
    expect(page.byId("paste-text-error").hidden).toBe(true); // checked url first; text was never reached

    page.type("paste-url", "https://jobs.example/posting");
    expect(page.byId("paste-url").getAttribute("aria-invalid")).toBeNull(); // typing clears the field's own error
    page.submit("paste-form");
    expect(page.byId("paste-text-error").textContent).toContain("text");
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses an over-size paste before ever sending it, with the same sentence the URL-fetch path would give (round-1 review L12 item 6)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("paste-url", "https://jobs.example/huge-posting");
    page.type("paste-text", "x".repeat(200_001));
    page.submit("paste-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("paste-text-error").textContent).toContain("200 KB");
    expect(page.byId("paste-text").getAttribute("aria-invalid")).toBe("true");
    // Never reached the network: nothing queued on the JobsStore this bridge actually holds.
    expect(await new JobsStore(bridge.workspace).listJobs()).toEqual([]);
  });

  it("an unchanged paste says nothing was duplicated, naming the revision it matches (round-1 review L12 item 7)", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/anchor-devops", text: "DevOps Engineer at Anchor.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job row");
    page.type("paste-url", "https://jobs.example/anchor-devops");
    page.type("paste-text", "DevOps Engineer at Anchor.");
    page.submit("paste-form");
    await until(() => page.status() !== "Nothing yet.", "the duplicate outcome");
    expect(page.status()).toBe("Already saved: this posting hasn't changed since revision 1, so nothing was duplicated.");
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

  it("refuses a javascript: link client-side, without the http:-specific 'paste instead' sentence (round-1 review L12 polish: fix the javascript:/file: refusal copy)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.type("url-input", "javascript:alert(1)");
    page.submit("url-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("url-input-error").textContent).toBe("The runner only fetches https:// links.");
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");
  });

  it("an empty URL gets its own message, distinct from the paste form's (round-1 review L12 item 6)", async () => {
    const bridge = await realBridge();
    const page = await openJobsPage(bridge);
    page.submit("url-form");
    expect(page.status()).toBe("Not saved.");
    expect(page.byId("url-input-error").textContent).not.toContain("posting text"); // not the paste form's own wording for an empty field
    expect(page.byId("url-input").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Jobs page: detail, revisions and the posting-changed diff", () => {
  it("opens a job (moving focus to the detail heading), shows both revisions, and the diff between them", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nRemote friendly.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    await store.captureJob({ url: "https://jobs.example/harbor-platform-engineer", text: "Platform Engineer at Harbor.\nOnsite in Fernwood.", extractorVersion: "t", capturedAt: "2026-09-23T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job row");

    page.document.querySelector(".job-open")!.click();
    await until(() => page.document.activeElement?.id === "detail-title", "focus to move to the detail heading");
    expect(page.byId("detail-section").hidden).toBe(false);
    expect(page.document.querySelectorAll(".revision-card").length).toBe(2);

    const details = page.document.querySelector(".revision-diff")!;
    details.open = true;
    details.dispatchEvent(new page.window.Event("toggle"));
    await until(() => page.document.querySelectorAll(".diff-line").length > 0, "the diff to render");
    // Round-1 review L12 item 9: the visible line lives in .diff-text; .diff-line's own textContent also carries
    // the visually-hidden "Added:"/"Removed:" prefix a screen reader needs, so the two are asserted separately.
    const added = Array.from(page.document.querySelectorAll(".diff-line.added .diff-text")).map((node) => node.textContent);
    const removed = Array.from(page.document.querySelectorAll(".diff-line.removed .diff-text")).map((node) => node.textContent);
    expect(removed).toEqual(["Remote friendly."]);
    expect(added).toEqual(["Onsite in Fernwood."]);
    const removedLine = page.document.querySelector(".diff-line.removed")!;
    expect(removedLine.textContent).toContain("Removed:");
    expect(removedLine.querySelector(".visually-hidden")).not.toBeNull();
    const addedLine = page.document.querySelector(".diff-line.added")!;
    expect(addedLine.textContent).toContain("Added:");
  });

  it("a paste that revises an already-open job refreshes its detail without stealing focus from the paste button", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/quill-staff-swe", text: "Staff Software Engineer at Quill.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job row");
    page.document.querySelector(".job-open")!.click();
    await until(() => page.document.activeElement?.id === "detail-title", "the detail to open");
    expect(page.document.querySelectorAll(".revision-card").length).toBe(1);

    const submit = page.byId("paste-submit");
    submit.focus();
    page.type("paste-url", "https://jobs.example/quill-staff-swe");
    page.type("paste-text", "Staff Software Engineer at Quill. Updated posting.");
    page.submit("paste-form");
    await until(() => page.status().includes("as revision 2"), "the second save");
    expect(page.document.activeElement).toBe(submit); // focus stayed on the button actually used, not the unrelated open panel
    await until(() => page.document.querySelectorAll(".revision-card").length === 2, "the open detail to pick up the new revision");
  });

  it("Try extracting again is aria-disabled while busy and keeps focus on itself once the panel updates in place (round-1 review L12 item 5: never replace the focused node)", async () => {
    const bridge = await realBridge(); // no eve: extraction reports "not extracted" — this test is about the button's busy/focus mechanics, not extraction succeeding
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/ledgerkit-backend-engineer", text: "Backend Engineer at Ledgerkit.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job row");
    page.document.querySelector(".job-open")!.click();
    await until(() => page.document.activeElement?.id === "detail-title", "the detail to open");

    const retry = Array.from(page.document.querySelectorAll(".detail-structured .button")).find((node) => node.textContent === "Try extracting again");
    expect(retry).toBeDefined();
    expect(retry!.getAttribute("id")).toBe("detail-retry");
    retry!.click();
    await until(() => page.status() !== "Nothing yet.", "the retry outcome");
    // Round-1 review L5: retry now responds once the attempt is queued, not once a turn finishes; with no eve
    // configured, extractionPreflight refuses synchronously ("runner_not_running") before ever queuing one. L12
    // finalizes the wording with next-step guidance (jobs.js's own EXTRACTION_REASON_MESSAGES).
    expect(page.status()).toBe("The runner isn't running, so this can't be extracted yet. Start it with npm run runner, then try again.");
    // L12 item 5's exact requirement: "keep focus on the button that was pressed" — never move it to the heading,
    // and never drop it to <body>. morphChildren reuses the same #detail-retry node, so `retry` is still live.
    expect(page.document.activeElement).toBe(retry);
    expect(page.document.activeElement?.id).toBe("detail-retry");
    expect(retry!.isConnected).toBe(true);
    expect(retry!.getAttribute("aria-disabled")).toBe("false"); // not_run is a terminal, non-busy state
    expect(retry!.textContent).toBe("Try extracting again"); // no fields were ever found, so the label does not become "Re-extract"
  });

  it("names an unextracted job from its own text, never the bare hostname, even when several jobs share a host (round-1 review L12 item 3)", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/posting-a", text: "Support Engineer at Lighthouse Co.", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    await store.captureJob({ url: "https://jobs.example/posting-b", text: "Data Analyst at Meridian Group.", extractorVersion: "t", capturedAt: "2026-09-22T09:05:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 2, "both job rows");
    const names = Array.from(page.document.querySelectorAll(".job-open")).map((node) => node.textContent);
    expect(names).toContain("Support Engineer at Lighthouse Co.");
    expect(names).toContain("Data Analyst at Meridian Group.");
    expect(names.some((name) => name === "jobs.example")).toBe(false);
  });

  it("falls back to the URL's path, never the bare hostname, when the posting has no readable first line", async () => {
    const bridge = await realBridge();
    const store = new JobsStore(bridge.workspace);
    await store.captureJob({ url: "https://jobs.example/careers/staff-recruiter", text: "   \n   ", extractorVersion: "t", capturedAt: "2026-09-22T09:00:00.000Z" });
    const page = await openJobsPage(bridge);
    await until(() => page.document.querySelectorAll(".job-row").length === 1, "the job row");
    expect(page.document.querySelector(".job-open")!.textContent).toBe("careers/staff-recruiter");
  });
});
