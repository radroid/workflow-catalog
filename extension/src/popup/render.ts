/**
 * Pure popup rendering. Split out of main.ts so these three states can be
 * unit-tested (and, for the P07-A acceptance screenshots, driven directly
 * with real extractor/build-job-capture output) without pulling in
 * main.ts's top-level orchestration side effects (`applyColorScheme()`
 * running immediately, `void run()` calling real `chrome.tabs`/
 * `chrome.scripting` APIs at import time, and the `#app`-must-already-exist
 * assertion).
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { ExtractedStructuredHints } from "../capture/extractor";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { setLastJobCapture } from "../shared/storage";

const RUNNER_JOBS_URL = "http://127.0.0.1:4310/ui/jobs.html";

export function renderLoading(app: Element): void {
  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("p", { className: "small", text: "Reading this page…" }),
    ]),
  );
}

export function renderFallback(app: Element, reason: string): void {
  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("div", { className: "flash bad", attrs: { role: "alert" }, text: reason }),
      el("p", { className: "small" }, [
        "Paste the posting in the runner's Jobs page instead: ",
        el("a", { attrs: { href: RUNNER_JOBS_URL, target: "_blank", rel: "noopener" }, text: RUNNER_JOBS_URL }),
      ]),
    ]),
  );
}

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  return `${(byteLength / 1024).toFixed(1)} KB`;
}

export function renderPreview(
  app: Element,
  capture: JobCapture,
  structured: ExtractedStructuredHints,
): void {
  const sizeBytes = new TextEncoder().encode(capture.text).length;

  const kvRows: Array<Node | string> = [el("dt", { text: "URL" }), el("dd", { text: capture.url })];
  if (structured.title) {
    kvRows.push(el("dt", { text: "Title" }), el("dd", { text: structured.title }));
  }
  if (structured.company) {
    kvRows.push(el("dt", { text: "Company" }), el("dd", { text: structured.company }));
  }
  if (structured.location) {
    kvRows.push(el("dt", { text: "Location" }), el("dd", { text: structured.location }));
  }
  kvRows.push(el("dt", { text: "Size" }), el("dd", { text: formatBytes(sizeBytes) }));

  const saveButton = el("button", { className: "primary", text: "Save this job" });
  const status = el("p", { className: "small", attrs: { role: "status", "aria-live": "polite" } });

  saveButton.addEventListener("click", () => {
    void (async () => {
      saveButton.disabled = true;
      saveButton.textContent = "Saving…";
      try {
        // Storage first: if the popup closes as a side effect of the
        // download below (focus loss), the options page's export view can
        // still recover this exact capture (P07 packet part A: "If a
        // popup closing on focus loss breaks the download, hand off to
        // the options page's export view").
        await setLastJobCapture(capture);
        downloadJson("job-capture.json", capture);
        status.textContent = "Saved job-capture.json. If nothing downloaded, use the options page to export it.";
        saveButton.textContent = "Saved ✓";
      } catch (error) {
        status.textContent = `Couldn't save: ${error instanceof Error ? error.message : String(error)}`;
        saveButton.textContent = "Save this job";
      } finally {
        // Disabling the focused button while "Saving…" moves focus to
        // <body> (a disabled element can't hold it) -- re-enable and
        // reclaim focus on both the success and failure path, so a
        // keyboard/screen-reader user isn't dropped back to the top of
        // the page after a click.
        saveButton.disabled = false;
        saveButton.focus();
      }
    })();
  });

  mount(
    app,
    el("main", { className: "popup stack" }, [
      el("h1", { className: "eyebrow", text: "Job Assistant" }),
      el("dl", { className: "kv" }, kvRows),
      el(
        "div",
        {
          className: "card pad excerpt",
          attrs: {
            tabindex: "0",
            role: "region",
            "aria-label": "Full captured text (scrollable)",
          },
        },
        // capture.text has already been through shared/text.ts's
        // normalizeWhitespace (build-job-capture.ts, before this ever
        // renders), which caps runs of 3+ blank lines down to one --
        // review issue 8's "collapse blank lines" without a second,
        // redundant collapsing pass here on what's already collapsed.
        [capture.text],
      ),
      el("p", {
        className: "small",
        text: "This page's text is saved as data. It can't trigger actions, no matter what it says.",
      }),
      saveButton,
      status,
    ]),
  );
}
