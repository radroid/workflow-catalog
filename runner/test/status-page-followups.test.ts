import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import type { EveGateway } from "../server/eve-gateway.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { BRIDGE, UI_TOKEN, makeBridge, pairDevice, type TestBridge } from "./helpers.ts";

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
  readonly className: string;
  hidden: boolean;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  getElementById(id: string): DomNode | null;
}
interface DomWindow {
  readonly document: DomDocument;
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

type Intercept = (input: string, init: { method?: string; body?: string }) => Promise<Response> | undefined;

interface Page {
  readonly document: DomDocument;
  readonly requests: string[];
  readonly results: string[];
  byId(id: string): DomNode;
}

async function openStatusPage(bridge: TestBridge, options: { intercept?: Intercept } = {}): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/status`, width: 1280, height: 800 });
  const html = await readFile(path.join(UI, "status.html"), "utf8");
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
  windows.push(window);
  const results: string[] = [];
  const resultNode = document.getElementById("model-result")!;
  let lastSeen = resultNode.textContent ?? "";
  new (window as unknown as { MutationObserver: new (callback: () => void) => { observe(node: DomNode, options: Record<string, boolean>): void } }).MutationObserver(() => {
    const now = resultNode.textContent ?? "";
    if (now === lastSeen) return;
    lastSeen = now;
    if (now !== "") results.push(now);
  }).observe(resultNode, { childList: true, subtree: true, characterData: true });
  vi.resetModules();
  await import(path.join(UI, "assets", "status.js"));
  // #checklist and #model-summary start with static "Loading…" placeholder text already in status.html's markup, so
  // waiting on either would resolve before loadStatus() ever runs. #eve-status starts empty in the markup and is the
  // last thing loadStatus() sets, so its becoming non-empty is what actually proves the first load settled.
  await until(() => (document.getElementById("eve-status")?.textContent ?? "").trim() !== "", "the page's first load to settle");
  return { document, requests, results, byId };
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

describe("Status page: Check the model keeps focus and announces once (item 4.1, K1/K8 round-1 revision)", () => {
  it("a successful check: focus never leaves the button, aria-disabled toggles, the result is set once, and only one request is ever sent", async () => {
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
    // K8 (polish): synchronously (the same tick as the click, before any await lets the check itself resolve),
    // #model-result is unhidden but still empty -- "Checking…" itself is deferred to the next frame, so it is a
    // genuine mutation on an already-present live region an AT can pick up, not text set in the same tick the node
    // went from hidden (outside the accessibility tree) to visible, which some screen readers never announce.
    expect(page.byId("model-result").hidden).toBe(false);
    expect(page.byId("model-result").textContent).toBe("");
    button.click(); // ignored: still busy
    button.click(); // ignored too: three presses total, none but the first must ever reach the server
    await until(() => button.getAttribute("aria-disabled") === "false", "the check to finish");
    expect(page.document.activeElement).toBe(button); // focus never moved, the whole time
    expect(page.byId("model-result").textContent).toBe("The model answered.");
    expect(page.byId("model-result").getAttribute("role")).toBe("status"); // present before the text changes, so a screen reader can announce it
    expect(page.results).toContain("Checking…"); // the deferred text did land, and was itself an observed mutation
    // K1 (reviewer issue 1): deleting the busy guard passed all 4 pre-revision tests, since none of them counted
    // requests -- only proof the guard actually suppressed the second and third presses' network calls closes that.
    expect(page.requests.filter((request) => request === "POST /api/model/check")).toHaveLength(1);
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

  it("a check that can't reach the runner: 'Can't reach the runner. Is it still running?', never 'Failed to fetch', and the busy state still clears", async () => {
    const bridge = await bridgeWith(fakeEve());
    const page = await openStatusPage(bridge, {
      intercept: (input, init) => ((init.method ?? "GET") === "POST" && input === "/api/model/check" ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    const button = page.byId("check-model");
    button.focus();
    button.click();
    await until(() => button.getAttribute("aria-disabled") === "false", "the check to finish");
    expect(page.document.activeElement).toBe(button); // focus never moved, even on this path
    expect(page.byId("model-result").textContent).toBe("Can't reach the runner. Is it still running?");
    expect(page.byId("model-result").textContent).not.toMatch(/Failed to fetch/);
  });

  it("a check with no eve running: the server's backticked command renders as <code>, never a literal backtick", async () => {
    // routes/model.ts answers 503 eve_not_running with a message that names `npm run runner` in backticks when
    // ctx.eve is unset; runner.js's shared getJson/postJson throw that exact message text as an Error.
    const bridge = await makeBridge({ modules: await loadRouteModules(ROUTES_DIR) }); // no eve passed at all
    const page = await openStatusPage(bridge);
    const button = page.byId("check-model");
    button.click();
    await until(() => button.getAttribute("aria-disabled") === "false", "the check to finish");
    const result = page.byId("model-result");
    expect(result.textContent).toBe("eve is not running. Start the runner with npm run runner.");
    const codeSpans = Array.from(result.querySelectorAll("code")).map((node) => node.textContent);
    expect(codeSpans).toEqual(["npm run runner"]); // rendered as an element, not left as literal backtick characters
  });
});

describe("Status page: the eve line is phrased for a person (item 4.2, K8 round-1 revision)", () => {
  it("never shows the eve client's own raw error text when eve doesn't answer, and names eve and how to start it again", async () => {
    // eve-gateway.ts's real health() turns a thrown client/fetch error into { ok: false, detail: shorten(error.message) }
    // -- the raw client error text this item is about. The fake reproduces that shape directly, no real transport needed.
    const bridge = await bridgeWith(fakeEve({ health: async () => ({ ok: false, detail: "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:3210" }) }));
    const page = await openStatusPage(bridge);
    const line = page.byId("eve-status").textContent ?? "";
    // K8: names eve, says how to start it again (npm run runner), and the url renders inside its own <code> element.
    expect(line).toBe(`eve isn't answering at ${bridge.ctx.eve!.url}. Start eve again with npm run runner in runner/.`);
    expect(line).not.toMatch(/error|fetch|ECONN|404|not found|TypeError/i); // no raw client/HTTP text leaks through
    const codeSpans = Array.from(page.byId("eve-status").querySelectorAll("code")).map((node) => node.textContent);
    expect(codeSpans).toEqual([bridge.ctx.eve!.url, "npm run runner"]);
  });

  it("says eve is answering, with its url, when it is", async () => {
    const bridge = await bridgeWith(fakeEve({ health: async () => ({ ok: true }) }));
    const page = await openStatusPage(bridge);
    expect(page.byId("eve-status").textContent).toBe(`eve is answering at ${bridge.ctx.eve!.url}.`);
  });
});

describe("Status page: the pairing buttons use aria-disabled and give plain errors (K11 round-1 revision)", () => {
  it("New pairing code keeps focus while busy, and shows a plain error on failure", async () => {
    const bridge = await bridgeWith(fakeEve());
    const page = await openStatusPage(bridge, {
      intercept: (input, init) => ((init.method ?? "GET") === "POST" && input === "/api/pairing/codes" ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    const button = page.byId("new-code");
    button.focus();
    button.click();
    // Never the native `disabled` attribute (which would drop focus to the body the instant it's set).
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(page.document.activeElement).toBe(button);
    await until(() => button.getAttribute("aria-disabled") === "false", "the request to finish");
    expect(page.document.activeElement).toBe(button); // focus never dropped to the body, even on this failure path
    expect(page.byId("page-error").textContent).toBe("Can't reach the runner. Is it still running?"); // plain, never "Failed to fetch"
    expect(page.byId("page-error").hidden).toBe(false);
  });

  it("Revoke keeps focus while busy, and shows a plain error on failure", async () => {
    const bridge = await bridgeWith(fakeEve());
    await pairDevice(bridge);
    const page = await openStatusPage(bridge, {
      intercept: (input, init) => ((init.method ?? "GET") === "POST" && input.includes("/revoke") ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    await until(() => page.byId("devices").querySelectorAll("button").length === 1, "the paired device's row");
    const revoke = page.byId("devices").querySelectorAll("button")[0]!;
    revoke.focus();
    revoke.click();
    expect(revoke.getAttribute("aria-disabled")).toBe("true");
    expect(page.document.activeElement).toBe(revoke);
    await until(() => revoke.getAttribute("aria-disabled") === "false", "the request to finish");
    expect(page.document.activeElement).toBe(revoke); // focus never dropped to the body
    expect(page.byId("page-error").textContent).toBe("Can't reach the runner. Is it still running?");
  });
});
