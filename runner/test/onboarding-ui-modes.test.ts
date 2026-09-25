import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window as HappyDomWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGithubSourceDeps, GITHUB_TOKEN_SECRET_NAME, type GithubFetchResult } from "../lib/github-source.ts";
import { MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import type { SafeFetchResult } from "../lib/safe-fetch.ts";
import { UI_COOKIE } from "../server/local-ui.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { createOnboardingRouteModule } from "../server/routes/onboarding.ts";
import { BRIDGE, UI_TOKEN, makeBridge, type TestBridge } from "./helpers.ts";

/**
 * The Onboarding page's own P03.1 UI (`ui/assets/onboarding.js`): the new
 * .pdf/.docx/.zip file input (kept separate from P03's .txt/.md one, so
 * neither's own refusal wording changes -- see `sourcePanel`'s comment), the
 * URL-import row, and the repositories category's GitHub section (both its
 * "already available" and "paste a token" states). Drives the real script
 * against the real `/api/onboarding` routes (`createOnboardingRouteModule`,
 * the same factory `onboarding-sources.test.ts` uses, so URL import never
 * touches the real network), through a minimal DOM harness -- a trimmed copy
 * of `ui-pages.test.ts`'s, kept in a new file since that one is shared with
 * P03.2 and restricted to its happy-dom import line.
 *
 * GitHub deps use the mutable seam on `defaultGithubSourceDeps`
 * (`lib/github-source.ts`), restored in `afterEach`, so nothing here spawns
 * the real `gh` CLI or touches the OS keychain.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..", "ui");
const FIXTURES = path.resolve(HERE, "..", "..", "packages", "job-assistant", "fixtures", "onboarding");
const COOKIE = `${UI_COOKIE}=${UI_TOKEN}`;

interface DomNode {
  readonly id: string;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly hidden: boolean;
  value: string;
  focus(): void;
  click(): void;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): DomNode | null;
}
interface DomDocument {
  readonly activeElement: DomNode | null;
  readonly body: { innerHTML: string };
  getElementById(id: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
interface DomWindow {
  readonly document: DomDocument;
  readonly HTMLElement: unknown;
  readonly ResizeObserver: unknown;
  readonly Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
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

interface Page {
  readonly document: DomDocument;
  byId(id: string): DomNode;
  line(): string;
  describedBy(id: string): string;
  type(id: string, text: string): void;
}

async function openOnboarding(bridge: TestBridge): Promise<Page> {
  const window = new Window({ url: `${BRIDGE}/ui/onboarding`, width: 1280, height: 800 });
  windows.push(window);
  const html = await readFile(path.join(UI, "onboarding.html"), "utf8");
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
  await import(path.join(UI, "assets", "onboarding.js"));
  const document = window.document;
  const byId = (id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const page: Page = {
    document,
    byId,
    line: () => byId("last-action").querySelector(".text")!.textContent ?? "",
    describedBy: (id) =>
      (byId(id).getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((ref) => document.getElementById(ref)?.textContent ?? `(missing ${ref})`)
        .join(" "),
    type: (id, text) => {
      const field = byId(id);
      field.value = text;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
  };
  await until(() => document.querySelectorAll("#readiness-lines li").length === 4, "onboarding to load");
  return page;
}

async function realBridge(fetchUrl?: (url: string) => Promise<SafeFetchResult>): Promise<TestBridge> {
  const modules: readonly LoadedRouteModule[] = [{ name: "onboarding", module: createOnboardingRouteModule(fetchUrl) }];
  return makeBridge({ modules });
}

function fakeFetchUrl(result: SafeFetchResult): (url: string) => Promise<SafeFetchResult> {
  return async () => result;
}

async function fixtureBuffer(name: string): Promise<ArrayBuffer> {
  const bytes = await readFile(path.join(FIXTURES, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function openResumePanel(page: Page): void {
  page.byId("source-status-resume-provided").click();
}

// --- GitHub deps: save/restore the mutable seam around every test in this file ------------------------

const originalGithubDeps = { ...defaultGithubSourceDeps };
afterEach(() => {
  defaultGithubSourceDeps.getGhCliToken = originalGithubDeps.getGhCliToken;
  defaultGithubSourceDeps.secrets = originalGithubDeps.secrets;
  defaultGithubSourceDeps.fetchGithub = originalGithubDeps.fetchGithub;
});

describe("the binary file input (kept separate from the .txt/.md one)", () => {
  it("uploads a PDF and shows it as a done outcome, while the original .txt/.md input still exists and still refuses a .pdf", async () => {
    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    openResumePanel(page);
    await until(() => page.line() === "Resume marked provided: add its text, then extract claims.", "the panel to open");

    // P03's own .txt/.md input is untouched: still there, under its own id, still only .txt/.md.
    const textOnlyInput = page.byId("source-file-resume");
    expect(textOnlyInput.getAttribute("id")).toBe("source-file-resume");

    const input = page.byId("source-binary-file-resume");
    const buffer = await fixtureBuffer("ada-quill-resume.pdf");
    Object.defineProperty(input, "files", { value: [{ name: "ada-resume.pdf", arrayBuffer: async () => buffer }], configurable: true });
    (input as unknown as { onchange(event: { currentTarget: DomNode }): void }).onchange({ currentTarget: input });

    await until(() => page.line() === "Uploaded ada-resume.pdf for Resume.", "the upload to finish", 10_000);
  });

  it("refuses a file that isn't .pdf, .docx or .zip, with its own plain message, distinct from the .txt/.md input's", async () => {
    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    openResumePanel(page);
    await until(() => page.line() === "Resume marked provided: add its text, then extract claims.", "the panel to open");

    const input = page.byId("source-binary-file-resume");
    input.focus();
    Object.defineProperty(input, "files", { value: [{ name: "notes.png", arrayBuffer: async () => new ArrayBuffer(0) }], configurable: true });
    (input as unknown as { onchange(event: { currentTarget: DomNode }): void }).onchange({ currentTarget: input });

    await until(() => page.line() === "Not uploaded: only .pdf, .docx or .zip files can be uploaded here.", "the short reason");
    expect(page.describedBy("source-binary-file-resume")).toContain("“notes.png” is not a .pdf, .docx or .zip file");
  });
});

describe("the URL-import row", () => {
  it("imports a public page's text and shows the done outcome", async () => {
    const html = "<html><body><h1>Ada Quill</h1><p>Portfolio: distributed systems, payments infrastructure.</p></body></html>";
    const bridge = await realBridge(fakeFetchUrl({ ok: true, status: 200, contentType: "text/html", text: html, finalUrl: "https://ada-quill.example/portfolio" }));
    const page = await openOnboarding(bridge);
    page.byId("source-status-portfolioSite-provided").click();
    await until(() => page.line() === "Portfolio / personal site marked provided: add its text, then extract claims.", "the panel to open");

    page.type("source-url-portfolioSite", "https://ada-quill.example/portfolio");
    page.byId("source-url-import-portfolioSite").click();

    await until(() => page.line() === "Imported https://ada-quill.example/portfolio for Portfolio / personal site.", "the import to finish", 5_000);
  });

  it("refuses an empty address without calling the server", async () => {
    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    page.byId("source-status-portfolioSite-provided").click();
    await until(() => page.line() === "Portfolio / personal site marked provided: add its text, then extract claims.", "the panel to open");

    page.byId("source-url-import-portfolioSite").click();
    await until(() => page.line() === "Not imported.", "the short reason");
    expect(page.describedBy("source-url-portfolioSite")).toContain("Type the address to import for Portfolio / personal site.");
  });
});

describe("the repositories category's GitHub section", () => {
  it("does not appear for a category other than repositories", async () => {
    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    openResumePanel(page);
    await until(() => page.line() === "Resume marked provided: add its text, then extract claims.", "the panel to open");
    expect(page.document.getElementById("github-import")).toBeNull();
    expect(page.document.getElementById("github-token-input")).toBeNull();
  });

  it("offers Import from GitHub once a token is available (gh-cli), and imports the fixture repositories", async () => {
    defaultGithubSourceDeps.getGhCliToken = async () => "gh_cli_fictional_token_0123456789";
    const fetched: GithubFetchResult[] = [
      { ok: true, json: [{ name: "payments-service", full_name: "ada-quill/payments-service", description: "Payments infra.", language: "TypeScript", topics: ["payments"] }] },
      { ok: true, json: { content: Buffer.from("# payments-service\n\nHandles Northwind Labs payments.").toString("base64"), encoding: "base64" } },
    ];
    let call = 0;
    defaultGithubSourceDeps.fetchGithub = async () => fetched[call++ % fetched.length]!;

    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    page.byId("source-status-repositories-provided").click();
    await until(() => page.line() === "Repositories marked provided: add its text, then extract claims.", "the panel to open");

    await until(() => page.document.getElementById("github-import") !== null, "the GitHub section to load its status", 5_000);
    page.byId("github-import").click();
    await until(() => page.line() === "Imported 1 repository for Repositories.", "the import to finish", 10_000);
  });

  it("offers a paste-a-token form when no token is available, and saves it", async () => {
    defaultGithubSourceDeps.getGhCliToken = async () => "";
    defaultGithubSourceDeps.secrets = new MemorySecretStore();

    const bridge = await realBridge();
    const page = await openOnboarding(bridge);
    page.byId("source-status-repositories-provided").click();
    await until(() => page.line() === "Repositories marked provided: add its text, then extract claims.", "the panel to open");

    await until(() => page.document.getElementById("github-token-input") !== null, "the paste-a-token form to load", 5_000);
    page.type("github-token-input", "github_pat_fictional_ada_0123456789");
    page.byId("github-token-save").click();

    await until(() => page.line() === "GitHub token saved. It's kept in your OS keychain, never in this workspace.", "the save to finish", 5_000);
    expect(await defaultGithubSourceDeps.secrets.get(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME)).toBe("github_pat_fictional_ada_0123456789");
  });
});
