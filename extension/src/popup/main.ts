import "../shared/zod-jitless";
import { buildJobCapture, MAX_INPAGE_TEXT_CHARS } from "../capture/build-job-capture";
import { extractJobPosting, isExtractionResult } from "../capture/extractor";
import { renderFallback, renderLoading, renderPreview } from "./render";
import { applyColorScheme } from "../shared/theme-init";
import { explainUnsupportedUrl } from "../shared/url";
import "./style.css";

applyColorScheme();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("popup/index.html is missing #app");
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

export async function run(): Promise<void> {
  renderLoading(app!);

  const tab = await getActiveTab();
  if (!tab || !tab.id || !tab.url) {
    renderFallback(app!, "Can't read this page — it has no readable address.");
    return;
  }

  const unsupportedReason = explainUnsupportedUrl(tab.url);
  if (unsupportedReason) {
    renderFallback(app!, unsupportedReason);
    return;
  }

  let injectionResults: chrome.scripting.InjectionResult[];
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobPosting,
      args: [MAX_INPAGE_TEXT_CHARS],
    });
  } catch {
    renderFallback(app!, "Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }

  const rawResult: unknown = injectionResults[0]?.result;
  if (!isExtractionResult(rawResult) || !rawResult.ok) {
    renderFallback(app!, "Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }
  const extraction = rawResult;

  // review issue 2: extraction.url is location.href read in the exact same
  // executeScript step as the text. tab.url was queried a moment earlier;
  // if the page navigated in between (an SPA route change is enough —
  // reproduced with a client-side pushState between the query and the
  // injected script actually running), they disagree, and text from one
  // URL must never be saved under a different one ("never silently save
  // the wrong job" — browser-boundary.md gate 5; F6 revisions are keyed by
  // URL). Refuse instead of guessing which one is right.
  if (extraction.url !== tab.url) {
    renderFallback(app!, "This page changed while it was being read — reopen the extension to try again.");
    return;
  }

  const built = await buildJobCapture({ url: extraction.url, rawText: extraction.text });
  if (!built.ok) {
    renderFallback(app!, built.reason);
    return;
  }

  renderPreview(app!, built.capture, extraction.structured);
}

void run();
