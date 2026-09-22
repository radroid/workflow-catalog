import "../shared/zod-jitless";
import { buildJobCapture } from "../capture/build-job-capture";
import { extractJobPosting } from "../capture/extractor";
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

async function run(): Promise<void> {
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
    });
  } catch {
    renderFallback(app!, "Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }

  const extraction = injectionResults[0]?.result as ReturnType<typeof extractJobPosting> | undefined;
  if (!extraction || !extraction.ok) {
    renderFallback(app!, "Can't read this page — paste the posting in the runner's Jobs page.");
    return;
  }

  const built = await buildJobCapture({ url: tab.url, rawText: extraction.text });
  if (!built.ok) {
    renderFallback(app!, built.reason);
    return;
  }

  renderPreview(app!, built.capture, extraction.structured);
}

void run();
