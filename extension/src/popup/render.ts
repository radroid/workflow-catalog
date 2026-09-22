/**
 * Pure popup rendering. Split out of main.ts so these three states can be
 * unit-tested (and, for the P07-A acceptance screenshots, driven directly
 * with real extractor/build-job-capture output) without pulling in
 * main.ts's top-level orchestration side effects (`applyColorScheme()`
 * running immediately, `void run()` calling real `chrome.tabs`/
 * `chrome.scripting` APIs at import time, and the `#app`-must-already-exist
 * assertion). No behavior change from what main.ts inlined before: same
 * markup, same textContent-only construction (see shared/dom.ts), same
 * copy.
 */
import type { JobCapture } from "@workflow-catalog/contracts";
import type { ExtractedStructuredHints } from "../capture/extractor";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { setLastJobCapture } from "../shared/storage";

const RUNNER_JOBS_URL = "http://127.0.0.1:4310/ui/jobs.html";
const EXCERPT_LENGTH = 280;

export function renderLoading(app: Element): void {
  mount(
    app,
    el("div", { className: "popup stack" }, [
      el("div", { className: "eyebrow", text: "Job Assistant" }),
      el("p", { className: "small", text: "Reading this page…" }),
    ]),
  );
}

export function renderFallback(app: Element, reason: string): void {
  mount(
    app,
    el("div", { className: "popup stack" }, [
      el("div", { className: "eyebrow", text: "Job Assistant" }),
      el("div", { className: "flash bad", text: reason }),
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
  const excerpt =
    capture.text.length > EXCERPT_LENGTH ? `${capture.text.slice(0, EXCERPT_LENGTH)}…` : capture.text;

  const kvRows: Array<Node | string> = [];
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
  const status = el("p", { className: "small" });

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
      } catch (error) {
        status.textContent = `Couldn't save: ${error instanceof Error ? error.message : String(error)}`;
        saveButton.disabled = false;
        saveButton.textContent = "Save this job";
      }
    })();
  });

  mount(
    app,
    el("div", { className: "popup stack" }, [
      el("div", { className: "eyebrow", text: "Job Assistant" }),
      el("dl", { className: "kv" }, kvRows),
      el("div", { className: "card pad" }, [el("div", { className: "excerpt", text: excerpt })]),
      saveButton,
      status,
    ]),
  );
}
