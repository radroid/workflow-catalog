import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterEach, vi } from "vitest";
import { UI_COOKIE } from "../server/local-ui.ts";
import { BRIDGE, UI_TOKEN, type TestBridge } from "./helpers.ts";

/**
 * A runner page's own script, run in happy-dom against the real bridge (the technique of jobs-page.test.ts and
 * application-page.test.ts, shared here for P06's pages and its Applications-page follow-ups). Requests go to
 * the bridge in-process with the page's cookie; `intercept` can answer one instead (a runner that hangs, say).
 * The fetch honours the page's AbortSignal, as a browser's does, and `requestTimeoutMs` shortens the pages'
 * 15-second request timeout so a test can wait it out.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const PAGE_REQUEST_TIMEOUT_MS = 15_000;
const realSetTimeout = globalThis.setTimeout;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Busy words: shown while a request takes a moment (over 300 ms), never an outcome. */
const BUSY = new Set(["Saving…", "Starting…", "Moving…"]);

export interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly className: string;
  readonly tagName: string;
  readonly parentElement: DomNode | null;
  hidden: boolean;
  value: string;
  checked: boolean;
  focus(): void;
  click(): void;
  closest(selector: string): DomNode | null;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

afterEach(async () => {
  while (pages.length > 0) {
    const page = pages.pop()!;
    page.setVisibility("hidden");
    await page.quiet();
    await page.window.happyDOM.close();
  }
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

export type Intercept = (input: string, init: { method?: string; body?: string }) => Promise<Response> | undefined;

export interface Page {
  readonly document: DomDocument;
  readonly window: DomWindow;
  /** Every text the live line's sentence showed, in order. */
  readonly lines: string[];
  /** The live line's outcomes: every text it showed, less the busy words a slow request shows first. */
  outcomes(): string[];
  /** Every text the whole live region showed (tag and sentence), in order, including empty states. */
  readonly regions: string[];
  readonly requests: string[];
  byId(id: string): DomNode;
  all(selector: string): DomNode[];
  visibleText(): string;
  setVisibility(state: "visible" | "hidden"): void;
  refreshNow(): void;
  /** Resolves once none of the page's requests has been in flight for 100 ms (at most 10 s). */
  quiet(): Promise<void>;
  submit(formId: string): void;
  /** Presses a button the way a person does: focus, then click. */
  press(id: string): DomNode;
}

export async function until(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      const page = pages.at(-1);
      throw new Error(`timed out waiting for ${what}${page ? `. The page showed lines ${JSON.stringify(page.lines)}; requests ${JSON.stringify(page.requests.slice(-10))}` : ""}`);
    }
    await sleep(10);
  }
}

export interface OpenOptions {
  /** The page's file name under runner/ui/, without `.html`. */
  readonly page: string;
  /** Resolves true once the page has finished its first load. */
  readonly ready: (document: DomDocument) => boolean;
  readonly intercept?: Intercept;
  /** What the pages' 15-second request timeout becomes, in this test. */
  readonly requestTimeoutMs?: number;
  readonly width?: number;
}

export async function openUiPage(bridge: TestBridge, options: OpenOptions): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/${options.page}`, width: options.width ?? 1280, height: 800 });
  const html = await readFile(path.join(UI, `${options.page}.html`), "utf8");
  (window.document as unknown as { body: { innerHTML: string } }).body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  const requests: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
  g.setTimeout = (callback: () => void, ms?: number) => window.setTimeout(callback, ms === PAGE_REQUEST_TIMEOUT_MS && options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : ms);
  g.clearTimeout = (handle: unknown) => window.clearTimeout(handle);
  let inFlight = 0;
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
    requests.push(`${init.method ?? "GET"} ${input}`);
    const stubbed = options.intercept?.(input, init);
    inFlight += 1;
    const response = stubbed ?? bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
    const aborted = new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error("aborted"));
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return Promise.race([response, aborted]).finally(() => (inFlight -= 1));
  };
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const lineText = () => byId("last-action").querySelector(".text")?.textContent ?? "";
  const regionText = () => byId("last-action").textContent ?? "";
  const lines: string[] = [];
  const regions: string[] = [];
  let lastLine = lineText();
  let lastRegion = regionText();
  new window.MutationObserver(() => {
    const line = lineText();
    if (line !== lastLine) {
      lastLine = line;
      if (line !== "") lines.push(line);
    }
    const region = regionText();
    if (region !== lastRegion) {
      lastRegion = region;
      regions.push(region);
    }
  }).observe(byId("last-action"), { childList: true, subtree: true, characterData: true });

  let visibility: "visible" | "hidden" = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const page: Page = {
    document,
    window,
    lines,
    outcomes: () => lines.filter((line) => !BUSY.has(line)),
    regions,
    requests,
    byId,
    all: (selector) => Array.from(document.querySelectorAll(selector)),
    visibleText: () => document.body.textContent ?? "",
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
    submit: (formId) => {
      byId(formId).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    press: (id) => {
      const button = byId(id);
      button.focus();
      button.click();
      return button;
    },
  };
  pages.push(page);
  vi.resetModules();
  await import(path.join(UI, "assets", `${options.page}.js`));
  await until(() => options.ready(document), `the ${options.page} page to finish loading`);
  return page;
}
