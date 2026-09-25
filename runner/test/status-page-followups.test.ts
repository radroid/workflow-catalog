import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * P06.1 item 4: the Status page's "Check the model" button and the eve line
 * (`docs/spec/implementation/P06.1-jobs-and-status-followups.md`; carried
 * from P03.2's round-2 and round-3 reviews). Duplicates a small happy-dom
 * harness, the same convention `jobs-page.test.ts` and `ui-pages.test.ts`
 * set (those files export nothing).
 *
 * A hand-rolled fake `EveGateway`, not `scripted-eve.ts`'s HTTP-level stub:
 * `openStatusPage` below already reassigns the process-global `fetch` so the
 * DOM's own (browser-side) calls reach the bridge; `scriptedEve` reassigns
 * that same global for eve's simulated transport, and since both live in one
 * process the second assignment silently wins and eve's stub never sees a
 * request. `jobs-page-followups.test.ts`'s `extractingEve` and P05's
 * `preparation-helpers.ts` hit the identical collision and avoid it the same
 * way: build the `EveGateway` object directly, with `health`/`checkModel`
 * returning a fixed result, never a `Client` that goes over HTTP.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;
const realSetTimeout = globalThis.setTimeout;

interface DomNode {
  readonly id: string;
  readonly textContent: string | null;
  hidden: boolean;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  getElementById(id: string): DomNode | null;
}
interface DomWindow {
  readonly document: DomDocument;
  setTimeout(callback: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly happyDOM: { close(): Promise<void> };
}

const { Window } = createRequire(path.join(HERE, "..", "..", "extension", "package.json"))("happy-dom") as {
  Window: new (options: { url: string; width: number; height: number }) => DomWindow;
};

const GLOBALS = ["window", "document", "fetch", "setTimeout", "clearTimeout"] as const;
const saved = new Map<string, unknown>(GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const windows: DomWindow[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

afterEach(async () => {
  while (windows.length > 0) await windows.pop()!.happyDOM.close();
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Page {
  readonly document: DomDocument;
  byId(id: string): DomNode;
}

async function openStatusPage(bridge: TestBridge): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/status`, width: 1280, height: 800 });
  const html = await readFile(path.join(UI, "status.html"), "utf8");
  (window.document as unknown as { body: { innerHTML: string } }).body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.setTimeout = (callback: () => void, ms?: number) => window.setTimeout(callback, ms);
  g.clearTimeout = (handle: unknown) => window.clearTimeout(handle);
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  windows.push(window);
  vi.resetModules();
  await import(path.join(UI, "assets", "status.js"));
  // #checklist and #model-summary start with static "Loading…" placeholder text already in status.html's markup, so
  // waiting on either would resolve before loadStatus() ever runs. #eve-status starts empty in the markup and is the
  // last thing loadStatus() sets, so its becoming non-empty is what actually proves the first load settled.
  await until(() => (document.getElementById("eve-status")?.textContent ?? "").trim() !== "", "the page's first load to settle");
  return { document, byId };
}

/** A fake `EveGateway`: fixed answers, no `Client`, no network. Defaults are the healthy case; each test overrides only what it's checking. */
function fakeEve(overrides: Partial<EveGateway> = {}): EveGateway {
  return {
    url: "http://127.0.0.1:3210",
    client: {} as never,
    health: async () => ({ ok: true }),
    modelId: async () => undefined,
    checkModel: async () => ({ ok: true }),
    ...overrides,
  };
}

async function bridgeWith(eve: EveGateway): Promise<TestBridge> {
  return makeBridge({ modules: await loadRouteModules(ROUTES_DIR), eve });
}

describe("Status page: Check the model keeps focus and announces once (item 4.1)", () => {
  it("a successful check: focus never leaves the button, aria-disabled toggles, and the result is set once the button is usable again", async () => {
    const bridge = await bridgeWith(fakeEve({ checkModel: async () => ({ ok: true }) }));
    const page = await openStatusPage(bridge);
    const button = page.byId("check-model");
    button.focus();
    expect(page.document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("false");

    button.click();
    // Never the native `disabled` attribute (which would drop focus to the body the instant it's set): aria-disabled
    // instead, and the click handler ignores a second press while busy.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(page.document.activeElement).toBe(button);
    button.click(); // ignored: still busy
    await until(() => button.getAttribute("aria-disabled") === "false", "the check to finish");
    expect(page.document.activeElement).toBe(button); // focus never moved, the whole time
    expect(page.byId("model-result").textContent).toBe("The model answered.");
    expect(page.byId("model-result").getAttribute("role")).toBe("status"); // present before the text changes, so a screen reader can announce it
  });

  it("a failed check: focus still stays, aria-disabled clears, and the plain failure detail shows", async () => {
    const bridge = await bridgeWith(fakeEve({ checkModel: async () => ({ ok: false, detail: "the model had a problem answering." }) }));
    const page = await openStatusPage(bridge);
    const button = page.byId("check-model");
    button.focus();
    button.click();
    await until(() => button.getAttribute("aria-disabled") === "false", "the check to finish");
    expect(page.document.activeElement).toBe(button);
    expect(page.byId("model-result").textContent).toBe("The check failed: the model had a problem answering.");
    expect(page.byId("model-result").getAttribute("class")).toContain("error");
  });
});

describe("Status page: the eve line is phrased for a person (item 4.2)", () => {
  it("never shows the eve client's own raw error text when eve doesn't answer", async () => {
    // eve-gateway.ts's real health() turns a thrown client/fetch error into { ok: false, detail: shorten(error.message) }
    // -- the raw client error text this item is about. The fake reproduces that shape directly, no real transport needed.
    const bridge = await bridgeWith(fakeEve({ health: async () => ({ ok: false, detail: "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:3210" }) }));
    const page = await openStatusPage(bridge);
    const line = page.byId("eve-status").textContent ?? "";
    expect(line).toBe(`eve isn't answering at ${bridge.ctx.eve!.url}. Make sure the runner is still running.`);
    expect(line).not.toMatch(/error|fetch|ECONN|404|not found|TypeError/i); // no raw client/HTTP text leaks through
  });

  it("says eve is answering, with its url, when it is", async () => {
    const bridge = await bridgeWith(fakeEve({ health: async () => ({ ok: true }) }));
    const page = await openStatusPage(bridge);
    expect(page.byId("eve-status").textContent).toBe(`eve is answering at ${bridge.ctx.eve!.url}.`);
  });
});
