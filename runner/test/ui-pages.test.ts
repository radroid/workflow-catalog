import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTES_DIR } from "../lib/paths.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import { loadRouteModules } from "../server/route-modules.ts";
import { MARKDOWN_UNREADABLE_REFUSAL } from "../server/routes/onboarding.ts";
import { ProfileStore } from "../store/profile.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * P03 revision 3, J4 (and J3, J6.3): the Onboarding and Profile pages' own
 * scripts, run in a DOM against the real `/api/onboarding` routes.
 *
 * - The control that has focus is never replaced by a render: after an
 *   action it is the very same node, and no focus event fires.
 * - When an action moves focus (Confirm opens a question), focus goes
 *   straight to the new target while the old control is still on the page,
 *   so it never passes through <body>; the old control goes afterwards.
 * - While career-profile.md can't be read, a refused write is one short line
 *   with no field error; Discard clears every field error; a field error goes
 *   with the next action; the Profile editor keeps unsaved text.
 *
 * happy-dom is not a runner dependency: adding it would change
 * runner/package.json and pnpm-lock.yaml, outside this packet's Owns. The
 * workspace already installs it for the extension (extension/package.json),
 * so it is resolved from there. The same behaviour is also checked in
 * Chromium by the packet's screenshot harness (see the P03 report).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;

// Just the DOM surface these tests touch: the runner's tsconfig has no DOM lib.
interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly hidden: boolean;
  readonly readOnly: boolean;
  value: string;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): DomNode | null;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  readonly body: DomNode & { innerHTML: string };
  getElementById(id: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  addEventListener(type: string, listener: (event: { readonly target: DomNode }) => void, capture?: boolean): void;
}
/** P03.2 (round-4 reviewer nit 4): just enough of MutationObserver to count how many times a node's text is written. */
interface DomMutationObserver {
  observe(target: DomNode, options: { readonly childList?: boolean; readonly characterData?: boolean; readonly subtree?: boolean }): void;
  disconnect(): void;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly HTMLElement: unknown;
  readonly ResizeObserver: unknown;
  readonly MutationObserver: new (callback: () => void) => DomMutationObserver;
  readonly Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
  requestAnimationFrame(callback: (time: number) => void): unknown;
  readonly happyDOM: { close(): Promise<void> };
}

const { Window } = createRequire(path.join(HERE, "..", "..", "extension", "package.json"))("happy-dom") as {
  Window: new (options: { url: string; width: number; height: number }) => DomWindow;
};

const GLOBALS = ["window", "document", "HTMLElement", "ResizeObserver", "requestAnimationFrame", "fetch"] as const;
const saved = new Map<string, unknown>(GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
const windows: DomWindow[] = [];

afterEach(async () => {
  while (windows.length > 0) await windows.pop()!.happyDOM.close();
  for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
});

interface Page {
  readonly window: DomWindow;
  readonly document: DomDocument;
  byId(id: string): DomNode;
  line(): string;
  describedBy(id: string): string;
  errors(): { readonly fieldErrors: number; readonly invalid: number };
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

/**
 * P03.2 (round-4 reviewer nit 4): counts how many separate times `#last-action
 * .text` is written — one MutationObserver callback per synchronous DOM
 * batch, which is what an aria-live region announces on (a same-tick clear
 * and refill inside one `lastAction()` call is one batch; `lastAction()`'s
 * own next-frame clear-then-refill, for repeating the same message, is a
 * second, deliberate one — outside what this counts, since every outcome
 * used below produces a message distinct from whatever was there before).
 */
function announcementCounter(page: Page): { count(): number } {
  const target = page.byId("last-action").querySelector(".text")!;
  let count = 0;
  const observer = new page.window.MutationObserver(() => {
    count += 1;
  });
  observer.observe(target, { childList: true, characterData: true, subtree: true });
  return { count: () => count };
}

/** Loads a page's HTML into a fresh DOM and runs its module against the bridge, as the browser would. */
async function openPage(name: "onboarding" | "profile", bridge: TestBridge): Promise<Page> {
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
  g.fetch = (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    bridge.request(input, { method: init.method, body: init.body, headers: { ...init.headers, cookie: COOKIE, origin: BRIDGE, "sec-fetch-site": "same-origin" } });
  vi.resetModules();
  await import(path.join(UI, "assets", `${name}.js`));
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const page: Page = {
    window,
    document,
    byId,
    line: () => byId("last-action").querySelector(".text")!.textContent ?? "",
    describedBy: (id) =>
      (byId(id).getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((ref) => document.getElementById(ref)?.textContent ?? `(missing ${ref})`)
        .join(" "),
    errors: () => ({
      fieldErrors: Array.from(document.querySelectorAll(".field-error")).filter((node) => !node.hidden).length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
    }),
    type: (id, text) => {
      const field = byId(id);
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    submit: (formId) => {
      byId(formId).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
  };
  await until(() => (name === "onboarding" ? document.querySelectorAll("#readiness-lines li").length === 4 : (document.getElementById("status-summary")?.textContent ?? "") !== ""), `${name} to load`);
  return page;
}

async function realBridge(): Promise<TestBridge> {
  return makeBridge({ modules: await loadRouteModules(ROUTES_DIR) });
}

/** Removes a boundary's marker from career-profile.md, as a person's editor might. */
async function damageMarkdown(bridge: TestBridge): Promise<void> {
  const store = new ProfileStore(bridge.ctx.workspace, bridge.ctx.clock);
  const boundary = (await store.load()).profile.boundaries[0]!; // load() writes a new profile and its file first
  const md = path.join(bridge.workspace.root, "career-profile.md");
  const text = await readFile(md, "utf8");
  expect(text).toContain(` \`[${boundary.id}]\``);
  await writeFile(md, text.replace(` \`[${boundary.id}]\``, ""));
}

describe("J4: the focused control is never replaced", () => {
  it("a status button is the very same node after its action, and no focus event fires", async () => {
    const bridge = await realBridge();
    const page = await openPage("onboarding", bridge);
    const focusins: string[] = [];
    const button = page.byId("source-status-resume-provided");
    button.focus();
    page.document.addEventListener("focusin", (event) => focusins.push(event.target.id), true);
    const announced = announcementCounter(page); // round-4 reviewer nit 4: this outcome is announced once
    button.click();
    await until(() => page.line() === "Resume marked provided: add its text, then extract claims.", "the outcome");
    await until(() => page.document.getElementById("source-text-resume")?.getAttribute("aria-busy") === null, "the saved text to load");
    expect(page.document.activeElement).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(focusins).toEqual([]);
    expect(announced.count()).toBe(1);
  });

  it("Confirm on a metric moves focus straight to its answer box, with the Confirm button still on the page, and the line says only that an answer is needed", async () => {
    const bridge = await realBridge();
    const store = new ProfileStore(bridge.ctx.workspace, bridge.ctx.clock);
    await store.accountSource("resume", "provided");
    const extracted = await store.extractClaims("resume", [{ text: "Cut report processing time by 30%.", kind: "metric", evidenceRef: "sources/resume/pasted.txt#L3", evidenceQuote: "Cut report processing time by 30%." }]);
    const id = extracted.profile.claims[0]!.id;
    const page = await openPage("onboarding", bridge);
    const ref = page.byId(`claim-card-${id}`).querySelector(".claim-evidence .ref")!;
    expect([ref.textContent, ref.getAttribute("title")]).toEqual(["pasted.txt, line 3", "sources/resume/pasted.txt#L3"]); // J6.9
    const confirm = page.byId(`claim-confirm-${id}`);
    confirm.focus();
    let confirmConnectedAtFocus: boolean | undefined;
    page.document.addEventListener("focusin", (event) => {
      if (event.target.id === `claim-answer-${id}`) confirmConnectedAtFocus = confirm.isConnected;
    }, true);
    confirm.click();
    await until(() => page.document.activeElement?.id === `claim-answer-${id}`, "focus on the answer box");
    expect(confirmConnectedAtFocus).toBe(true); // focus moved directly, never through <body>
    expect(confirm.isConnected).toBe(false); // and the old button went afterwards
    expect(page.line()).toBe("An answer is needed.");
    const described = page.describedBy(`claim-answer-${id}`);
    expect(described).toContain((await store.read()).claims[0]!.question!);
    expect(described).toMatch(/Asked because it's a metric claim\.$/); // J6.4
  });
});

describe("J3 and J6.3: refusals and field errors", () => {
  it("while career-profile.md can't be read, a refused write is the one short line: no field error, no aria-invalid, focus and typed text stay", async () => {
    const bridge = await realBridge();
    await damageMarkdown(bridge);
    const page = await openPage("onboarding", bridge);
    expect(page.byId("markdown-problem").hidden).toBe(false);
    expect(page.byId("markdown-problem-text").textContent).toMatch(/^Line \d+: the line for the boundary “Do not invent metrics, credentials, or responsibilities\.” is missing/);
    const input = page.byId("statement-input-preference");
    input.focus();
    page.type("statement-input-preference", "Remote-first roles.");
    page.submit("statement-form-preference");
    await until(() => page.line() === MARKDOWN_UNREADABLE_REFUSAL, "the refusal");
    expect(page.errors()).toEqual({ fieldErrors: 0, invalid: 0 });
    expect(page.document.activeElement).toBe(input);
    expect(input.value).toBe("Remote-first roles.");
  });

  it("a field error sits on its field with the short outcome in the line, and goes with the next unrelated action", async () => {
    const bridge = await realBridge();
    const page = await openPage("onboarding", bridge);
    const input = page.byId("statement-input-preference");
    input.focus();
    page.submit("statement-form-preference");
    // P03.2 (round-4 UI critic polish 1): the input still has focus, so the line carries the short reason
    // too, not just "Not added." -- see the dedicated describe block below for that behaviour on its own.
    await until(() => page.line() === "Not added: type a preference first.", "the refusal");
    expect(page.describedBy("statement-input-preference")).toContain("Type a preference first, then add it.");
    expect(page.errors()).toEqual({ fieldErrors: 1, invalid: 1 });
    expect(page.document.activeElement).toBe(input);
    page.byId("source-status-workSamples-unavailable").click();
    await until(() => page.line() === "Work samples marked unavailable.", "the next action");
    expect(page.errors()).toEqual({ fieldErrors: 0, invalid: 0 });
  });

  it("Discard clears every field error and moves focus to the page title before the note is hidden", async () => {
    const bridge = await realBridge();
    await damageMarkdown(bridge);
    const page = await openPage("onboarding", bridge);
    page.byId("statement-input-boundary").focus();
    page.submit("statement-form-boundary");
    await until(() => page.errors().fieldErrors === 1, "a field error");
    const discard = page.byId("markdown-discard");
    discard.focus();
    discard.click();
    await until(() => page.line() === "Discarded your edits: career-profile.md was rewritten from your profile.", "the discard");
    expect(page.errors()).toEqual({ fieldErrors: 0, invalid: 0 });
    expect(page.byId("markdown-problem").hidden).toBe(true);
    expect(page.document.activeElement?.id).toBe("page-title");
  });
});

describe("J3 on the Profile page", () => {
  it("shows the file as it is on disk, read-only, with no Save, while it can't be read", async () => {
    const bridge = await realBridge();
    await damageMarkdown(bridge);
    const page = await openPage("profile", bridge);
    const editor = page.byId("markdown-editor");
    expect(editor.value).toBe(await readFile(path.join(bridge.workspace.root, "career-profile.md"), "utf8"));
    expect(editor.readOnly).toBe(true);
    expect(page.byId("save-markdown").hidden).toBe(true);
    expect(page.byId("markdown-editor-label").textContent).toMatch(/^The file as it is on disk/);
  });

  it("a save that finds the file unreadable keeps the typed text, moves focus to the note, and Discard keeps the text too", async () => {
    const bridge = await realBridge();
    const page = await openPage("profile", bridge);
    const editor = page.byId("markdown-editor");
    const typed = editor.value.replace("Do not change employment dates or official titles.", "Never change a date or a title.");
    expect(typed).not.toBe(editor.value);
    page.type("markdown-editor", typed);
    await damageMarkdown(bridge);
    const save = page.byId("save-markdown");
    save.focus();
    let saveHiddenAtFocus: boolean | undefined;
    page.document.addEventListener("focusin", (event) => {
      if (event.target.id === "markdown-problem") saveHiddenAtFocus = save.hidden;
    }, true);
    save.click();
    await until(() => page.line() === MARKDOWN_UNREADABLE_REFUSAL, "the refusal");
    expect(page.document.activeElement?.id).toBe("markdown-problem");
    expect(saveHiddenAtFocus).toBe(false); // focus left Save while it was still shown, never through <body>
    expect(save.hidden).toBe(true); // Save isn't offered while the file can't be read
    expect(editor.value).toBe(typed);
    expect(editor.readOnly).toBe(false);
    page.byId("markdown-discard").click();
    await until(() => page.line() === "File edits discarded; your unsaved text in the box is kept.", "the discard");
    expect(editor.value).toBe(typed);
    expect(save.hidden).toBe(false);
  });
});

describe("P03.2 (round-4 reviewer nit 2): a stale editor error does not survive an unrelated action", () => {
  it("Accept on a pending revision clears a red editor left by an earlier failed save", async () => {
    const bridge = await realBridge();
    const store = new ProfileStore(bridge.ctx.workspace, bridge.ctx.clock);
    // One pending revision to accept: approve, then a hand edit becomes a proposed revision (D9, D11).
    await store.accountSource("resume", "provided");
    const claimId = (await store.extractClaims("resume", [{ text: "Worked on the Harbor deployment pipeline.", kind: "fact", evidenceRef: "resume.md#harbor", evidenceQuote: "Harbor" }])).profile.claims[0]!.id;
    await store.decideClaim(claimId, "confirmed");
    for (const category of SOURCE_CATEGORIES) if (category !== "resume") await store.accountSource(category, "not_applicable");
    expect((await store.approve()).ok).toBe(true);
    const md = path.join(bridge.workspace.root, "career-profile.md");
    await writeFile(md, (await readFile(md, "utf8")).replace("Worked on the Harbor deployment pipeline.", "Rebuilt the Harbor deployment pipeline."));

    const page = await openPage("profile", bridge);
    await until(() => page.document.querySelectorAll(".revision").length === 1, "the pending revision to render");

    // Break a save first (the marker for the confirmed claim goes missing from the submitted text), so
    // editorError is set: the editor shows red, described by the field error (J4).
    const editor = page.byId("markdown-editor");
    page.type("markdown-editor", editor.value.replace(` \`[${claimId}]\``, ""));
    page.byId("save-markdown").click();
    await until(() => page.errors().invalid > 0, "the field error to appear");
    expect(page.errors()).toEqual({ fieldErrors: 1, invalid: 1 });

    // An unrelated action — Accept the pending revision — must not leave that stale red state up.
    const revision = page.document.querySelectorAll(".revision")[0]!;
    const accept = revision.querySelector(".revision-actions button")!;
    accept.click();
    await until(() => page.document.querySelectorAll(".revision").length === 0, "the revision to be accepted");
    expect(page.errors()).toEqual({ fieldErrors: 0, invalid: 0 });
    expect(page.byId("markdown-editor-error").hidden).toBe(true);
  });
});

describe("P03.2 (round-4 UI critic polish 1): a refused control that still has focus gets a short reason in the line", () => {
  it("an upload with the wrong extension is not just \"Not uploaded.\" while the file input still has focus", async () => {
    const bridge = await realBridge();
    const page = await openPage("onboarding", bridge);
    page.byId("source-status-resume-provided").click();
    await until(() => page.line() === "Resume marked provided: add its text, then extract claims.", "the source to open its panel");

    const input = page.byId("source-file-resume");
    input.focus();
    expect(page.document.activeElement).toBe(input);
    // A plain object stands in for a picked File: onboarding.js's upload() only reads .name before this
    // refusal, and happy-dom's own File/FileList support is untested surface this repo doesn't otherwise
    // need. Direct property assignment, not dispatchEvent: .files is a real input's own read-only property,
    // and onchange is called the same way a real "change" event would invoke it.
    Object.defineProperty(input, "files", { value: [{ name: "resume.pdf" }], configurable: true });
    (input as unknown as { onchange(event: { currentTarget: DomNode }): void }).onchange({ currentTarget: input });

    await until(() => page.line() === "Not uploaded: only .txt or .md files can be uploaded.", "the short reason");
    expect(page.document.activeElement).toBe(input); // focus never moved, so the line had to carry the reason
    // The fuller reason (with the file's name) still sits next to the field, for anyone who does move to it.
    expect(page.describedBy("source-file-resume")).toContain("“resume.pdf” is not a .txt or .md file");
  });

  it("Enter in an empty statement input is not just \"Not added.\" while the input still has focus", async () => {
    const bridge = await realBridge();
    const page = await openPage("onboarding", bridge);

    const input = page.byId("statement-input-boundary");
    input.focus();
    expect(page.document.activeElement).toBe(input);
    page.submit("statement-form-boundary"); // a form's native Enter-submits-itself behaviour, scripted directly

    await until(() => page.line() === "Not added: type a boundary first.", "the short reason");
    expect(page.document.activeElement).toBe(input);
    expect(page.describedBy("statement-input-boundary")).toContain("Type a boundary first, then add it.");
  });
});
