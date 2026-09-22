import "../shared/zod-jitless";
import type { JobCapture } from "@workflow-catalog/contracts";
import { buildJobCapture } from "../capture/build-job-capture";
import { extractJobPosting, type ExtractedStructuredHints } from "../capture/extractor";
import { el, mount } from "../shared/dom";
import { downloadJson } from "../shared/download";
import { setLastJobCapture } from "../shared/storage";
import { applyColorScheme } from "../shared/theme-init";
import { explainUnsupportedUrl } from "../shared/url";
import "./style.css";

applyColorScheme();

const RUNNER_JOBS_URL = "http://127.0.0.1:4310/ui/jobs.html";
const EXCERPT_LENGTH = 280;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("popup/index.html is missing #app");
}

function renderLoading(): void {
  mount(
    app!,
    el("div", { className: "popup stack" }, [
      el("div", { className: "eyebrow", text: "Job Assistant" }),
      el("p", { className: "small", text: "Reading this page…" }),
    ]),
  );
}

function renderFallback(reason: string): void {
  mount(
    app!,
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

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  return `${(byteLength / 1024).toFixed(1)} KB`;
}

function renderPreview(capture: JobCapture, structured: ExtractedStructuredHints): void {
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
    app!,
    el("div", { className: "popup stack" }, [
      el("div", { className: "eyebrow", text: "Job Assistant" }),
      el("dl", { className: "kv" }, kvRows),
      el("div", { className: "card pad" }, [el("div", { className: "excerpt", text: excerpt })]),
      saveButton,
      status,
    ]),
  );
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function run(): Promise<void> {
  renderLoading();

  const tab = await getActiveTab();
  if (!tab || !tab.id || !tab.url) {
    renderFallback("Can't read this page — it has no readable address.");
    return;
  }

  const unsupportedReason = explainUnsupportedUrl(tab.url);
  if (unsupportedReason) {
    renderFallback(unsupportedReason);
    return;
  }

  let injectionResults: chrome.scripting.InjectionResult[];
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobPosting,
    });
  } catch {
    renderFallback("Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }

  const extraction = injectionResults[0]?.result as ReturnType<typeof extractJobPosting> | undefined;
  if (!extraction || !extraction.ok) {
    renderFallback("Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }

  const built = await buildJobCapture({ url: tab.url, rawText: extraction.text });
  if (!built.ok) {
    renderFallback(built.reason);
    return;
  }

  renderPreview(built.capture, extraction.structured);
}

void run();
