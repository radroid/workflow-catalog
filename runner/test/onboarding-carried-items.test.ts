import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window as HappyDomWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { MARKDOWN_UNREADABLE_REFUSAL } from "../server/routes/onboarding.ts";
import { ProfileStore } from "../store/profile.ts";
import { PROFILE_BUSY_MESSAGE, PROFILE_LOCK_SEGMENTS } from "../store/profile-writes.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * P03.1's two items carried in from P03.2's reviews
 * (docs/spec/implementation/P03.1-onboarding-sources.md, "Carried in from
 * P03.2's round-2 review" and its round-3 addendum):
 *
 * 1. A "profile busy" refusal used to wait out `refused()`'s own reload of
 *    the page (waiting on the very same lock that just refused the write)
 *    before showing the message -- about 10 s of nothing happening, then the
 *    refusal. `onboarding.js`'s `refused()` and `profile.js`'s `run()` catch
 *    block now announce the refusal immediately and never reload afterward:
 *    the reload's only purpose was fresher data for whatever the person does
 *    next, and every action on both pages already starts with its own
 *    `load()`/`refresh()`, so the next real action reloads regardless.
 * 2. A page-load failure's line used to concatenate the raw error message
 *    with " Reload the page to try again." unconditionally, producing a
 *    run-on with no full stop for a network failure ("...Failed to fetch
 *    Reload the page to try again.") and a doubled "try again" for a busy
 *    lock ("...Try again in a moment. Reload the page to try again.").
 *    `pageLoadErrorText()` in each file fixes both.
 *
 * This file has its own minimal DOM harness (a trimmed copy of
 * `ui-pages.test.ts`'s) because the packet's Owns restricts
 * `ui-pages.test.ts` -- shared with P03.2 -- to its happy-dom import line
 * only. This file is new and belongs to P03.1 alone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;

interface DomNode {
  readonly textContent: string | null;
  readonly hidden: boolean;
  click(): void;
  querySelector(selector: string): DomNode | null;
}
interface DomDocument {
  readonly body: { innerHTML: string };
  getElementById(id: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly HTMLElement: unknown;
  readonly ResizeObserver: unknown;
  requestAnimationFrame(callback: (time: number) => void): unknown;
  readonly happyDOM: { close(): Promise<void> };
}

const Window = HappyDomWindow as unknown as new (options: { url: string; width: number; height: number }) => DomWindow;

const GLOBALS = ["window", "document", "HTMLElement", "ResizeObserver", "requestAnimationFrame", "fetch"] as const;
const saved = new Map<string, unknown>(GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const windows: DomWindow[] = [];

afterEach(async () => {
  while (windows.length > 0) await windows.pop()!.happyDOM.close();
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchImpl = (input: string, init?: FetchInit) => Promise<Response>;

/** Mounts a page's HTML and runs its module against the given fetch implementation, as the browser would. */
async function mountPage(name: "onboarding" | "profile", fetchImpl: FetchImpl): Promise<DomDocument> {
  const window = new Window({ url: `${BRIDGE}/ui/${name}`, width: 1280, height: 800 });
  windows.push(window);
  const html = await readFile(path.join(UI, `${name}.html`), "utf8");
  window.document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.ResizeObserver = window.ResizeObserver;
  g.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
  g.fetch = fetchImpl;
  vi.resetModules();
  await import(path.join(UI, "assets", `${name}.js`));
  return window.document;
}

/** A fetch that talks to a real bridge with `ui-pages.test.ts`'s same headers, recording every request's method and path. */
function bridgeFetch(bridge: TestBridge, requests: string[]): FetchImpl {
  return (input, init = {}) => {
    requests.push(`${init.method ?? "GET"} ${input}`);
    return bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
  };
}

async function realBridge(): Promise<TestBridge> {
  return makeBridge({ modules: await loadRouteModules(ROUTES_DIR) });
}

/** Simulates another process holding the cross-process profile lock (store/profile-writes.ts). Left held: the temp workspace is removed by helpers.ts's own afterEach regardless. */
async function holdProfileLock(bridge: TestBridge): Promise<void> {
  const lock = path.join(bridge.workspace.root, ...PROFILE_LOCK_SEGMENTS);
  await writeFile(lock, `${JSON.stringify({ token: "another-process", pid: 999999, acquiredAt: new Date().toISOString() })}\n`);
}

describe("P03.1 carried item 1: a busy refusal is announced without a trailing reload", () => {
  it("onboarding: a source-status click refused by the profile lock announces immediately and issues no follow-up GET", async () => {
    const bridge = await realBridge();
    const requests: string[] = [];
    const document = await mountPage("onboarding", bridgeFetch(bridge, requests));
    await until(() => document.querySelectorAll("#readiness-lines li").length === 4, "onboarding to load");
    requests.length = 0; // only what happens after the page is up matters below

    // Deliberately left held for the rest of the test: the old bug's reload, run after the announcement,
    // would have waited this same lock out a second time (that's the ~10 s the carried item describes).
    await holdProfileLock(bridge);
    const line = () => document.getElementById("last-action")!.querySelector(".text")!.textContent ?? "";
    document.getElementById("source-status-resume-provided")!.click();
    await until(() => line() === PROFILE_BUSY_MESSAGE, "the busy refusal", 15_000);
    // Exactly the one POST that got refused -- no GET /api/onboarding after it, which is what a reload would add.
    expect(requests).toEqual(["POST /api/onboarding/sources/resume"]);
  });
});

/** Removes a boundary's marker from career-profile.md, as a person's editor might (ui-pages.test.ts's own damageMarkdown, duplicated: that file's Owns is restricted to its happy-dom import line only). */
async function damageMarkdown(bridge: TestBridge): Promise<void> {
  const store = new ProfileStore(bridge.ctx.workspace, bridge.ctx.clock);
  const boundary = (await store.load()).profile.boundaries[0]!; // load() writes a new profile and its file first
  const md = path.join(bridge.workspace.root, "career-profile.md");
  const text = await readFile(md, "utf8");
  expect(text).toContain(` \`[${boundary.id}]\``);
  await writeFile(md, text.replace(` \`[${boundary.id}]\``, ""));
}

describe("Gate fix round 1, B1: a refusal that names the note at the top makes that note appear", () => {
  it("onboarding: career-profile.md is damaged after the page is already open; the next refused write reloads and reveals #markdown-problem", async () => {
    const bridge = await realBridge();
    const requests: string[] = [];
    const document = await mountPage("onboarding", bridgeFetch(bridge, requests));
    await until(() => document.querySelectorAll("#readiness-lines li").length === 4, "onboarding to load");
    // The page's own initial load ran first, clean, so #markdown-problem starts hidden: the corruption
    // below happens only *after* that load, the reviewer's exact reproduction (a hand edit while the
    // page is already open) -- not the already-covered case where the page loads already damaged.
    expect(document.getElementById("markdown-problem")!.hidden).toBe(true);

    await damageMarkdown(bridge);
    const line = () => document.getElementById("last-action")!.querySelector(".text")!.textContent ?? "";
    document.getElementById("source-status-workSamples-unavailable")!.click();
    await until(() => line() === MARKDOWN_UNREADABLE_REFUSAL, "the refusal");
    // The refusal's own line says "See the note at the top.": without B1's fix, the note stays hidden
    // forever (the refusal's response never carries markdownError; only a fresh GET does).
    await until(() => document.getElementById("markdown-problem")!.hidden === false, "the note to appear");
    expect(document.getElementById("markdown-problem-text")!.textContent).toMatch(/^Line \d+: /);
  });
});

describe("P03.1 carried item 2: the page-load error line", () => {
  it("onboarding: a network failure's message gets a closing full stop before the reload hint", async () => {
    const failingFetch: FetchImpl = async () => {
      throw new TypeError("Failed to fetch"); // fetch's own wording for a connection that never got a response
    };
    const document = await mountPage("onboarding", failingFetch);
    const node = () => document.getElementById("page-error")!;
    await until(() => !node().hidden, "the page-load error");
    expect(node().textContent).toBe("The onboarding page couldn't load: Failed to fetch. Reload the page to try again.");
  });

  it("profile: a busy lock on the initial load doesn't repeat \"try again\" twice", async () => {
    const bridge = await realBridge();
    await holdProfileLock(bridge);
    const document = await mountPage("profile", bridgeFetch(bridge, []));
    const node = () => document.getElementById("page-error")!;
    await until(() => !node().hidden, "the page-load error", 15_000);
    // The server's own message already says "Try again in a moment.": no second, redundant reload sentence.
    expect(node().textContent).toBe(`The profile couldn't load: ${PROFILE_BUSY_MESSAGE}`);
  });
});
