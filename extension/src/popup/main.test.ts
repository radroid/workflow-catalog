import "../shared/zod-jitless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * main.ts's `run()` calls `applyColorScheme()` and asserts `#app` exists
 * as soon as the module is *imported* (not when `run()` is called) — a
 * static top-level `import` would be hoisted ahead of any DOM setup this
 * file does, so every test here sets up `document.body` first and then
 * dynamically imports (`await import("./main")`), which — unlike a static
 * import — genuinely runs at that point in execution order.
 * `vi.resetModules()` is required, not optional: without it, `import`'s
 * module cache returns the *same* evaluated module on every test's dynamic
 * import, whose top-level `const app = document.querySelector("#app")`
 * only ever captured the first test's `#app` element — every later test's
 * fresh `beforeEach`-created element would be invisible to it, silently
 * rendering into a detached node instead of the one this file's own
 * `document.querySelector("#app")` assertions look at.
 */

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  document.body.innerHTML = "";
  // @ts-expect-error -- test cleanup of a partial chrome stub
  delete globalThis.chrome;
});

describe("popup main.ts run() (review issue 2: never save one job's text under another job's URL)", () => {
  it("refuses with a visible alert when the page navigated between the tab query and extraction (SPA route change)", async () => {
    globalThis.chrome = {
      tabs: {
        query: async () => [{ id: 1, url: "https://jobs.example/postings/a" }],
      },
      scripting: {
        executeScript: async () => [
          {
            result: {
              ok: true,
              // Extraction actually ran against a *different* URL than the
              // one queried a moment earlier -- exactly what a client-side
              // route change between those two steps produces.
              text: "Posting B's real text, long enough to pass the minimum captured length floor here.",
              structured: {},
              url: "https://jobs.example/postings/b",
            },
          },
        ],
      },
      // A deliberately partial stub of the real chrome.* surface -- a
      // single cast (rather than @ts-expect-error, which only suppresses
      // a diagnostic on one specific line) covers every nested property
      // mismatch a multi-line object literal like this produces against
      // @types/chrome's full, strict typing.
    } as unknown as typeof chrome;

    const { run } = await import("./main");
    await run();

    const app = document.querySelector("#app");
    expect(app?.textContent).toContain("changed while it was being read");
    expect(app?.querySelector('[role="alert"]')).not.toBeNull();
    // Never rendered as a preview -- no Save button, no URL row claiming
    // either posting's URL for text that might not match it.
    expect(app?.querySelector("button.primary")).toBeNull();
  });

  it("proceeds to the preview, with the extracted URL, when the tab URL and the extraction-time URL agree", async () => {
    globalThis.chrome = {
      tabs: {
        query: async () => [{ id: 1, url: "https://jobs.example/postings/a" }],
      },
      scripting: {
        executeScript: async () => [
          {
            result: {
              ok: true,
              text: "Posting A's real text, long enough to pass the minimum captured length floor here.",
              structured: { title: "Staff Engineer" },
              url: "https://jobs.example/postings/a",
            },
          },
        ],
      },
    } as unknown as typeof chrome;

    const { run } = await import("./main");
    await run();

    const app = document.querySelector("#app");
    expect(app?.querySelector("button.primary")?.textContent).toBe("Save this job");
    expect(app?.querySelector("dd")?.textContent).toBe("https://jobs.example/postings/a");
  });

  it("passes the in-page character cap to executeScript's args (review issue 3 fold-in: oversized pages shouldn't cross the boundary in full)", async () => {
    let capturedArgs: unknown;
    globalThis.chrome = {
      tabs: { query: async () => [{ id: 1, url: "https://jobs.example/postings/a" }] },
      scripting: {
        executeScript: async (options: { args?: unknown[] }) => {
          capturedArgs = options.args;
          return [
            {
              result: {
                ok: true,
                text: "Enough real content here to pass the minimum captured length floor.",
                structured: {},
                url: "https://jobs.example/postings/a",
              },
            },
          ];
        },
      },
    } as unknown as typeof chrome;

    const { run } = await import("./main");
    await run();

    expect(Array.isArray(capturedArgs)).toBe(true);
    expect(typeof (capturedArgs as unknown[])[0]).toBe("number");
    expect((capturedArgs as [number])[0]).toBeGreaterThan(0);
  });

  it("refuses instead of trusting a malformed executeScript result (review issue 3 fold-in: validate the returned shape before use)", async () => {
    globalThis.chrome = {
      tabs: { query: async () => [{ id: 1, url: "https://jobs.example/postings/a" }] },
      scripting: {
        // Not a real ExtractionResult at all -- e.g. a page whose own
        // globals clobbered something, or a future Chrome bug.
        executeScript: async () => [{ result: { unexpected: "shape" } }],
      },
    } as unknown as typeof chrome;

    const { run } = await import("./main");
    await run();

    const app = document.querySelector("#app");
    expect(app?.querySelector('[role="alert"]')).not.toBeNull();
    expect(app?.querySelector("button.primary")).toBeNull();
  });
});
