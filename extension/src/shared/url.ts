/**
 * Proactive URL-scheme gate for capture, ahead of even attempting
 * `chrome.scripting.executeScript`. Mirrors the schemes
 * `@workflow-catalog/contracts`' `httpUrlSchema` accepts (http/https only —
 * see primitives.ts) so a URL this module clears can never fail that
 * schema later. browser-boundary.md's acceptance gates: "reject
 * `javascript:`, local files, privileged browser URLs, and arbitrary
 * code."
 */

const NAMED_REFUSAL_REASONS: Record<string, string> = {
  "chrome:": "This is a Chrome settings page, not a job posting.",
  "chrome-extension:": "This is an extension page, not a job posting.",
  "devtools:": "This is a DevTools page, not a job posting.",
  "edge:": "This is a browser settings page, not a job posting.",
  "about:": "This is a browser page, not a job posting.",
  "file:": "Local files can't be captured — the extension can only read http(s) pages.",
  "javascript:": "javascript: URLs can't be captured.",
  "data:": "data: URLs can't be captured.",
  "view-source:": "This is a source-view page, not a job posting.",
  "chrome-search:": "This is a browser page, not a job posting.",
  "blob:": "This page's content isn't readable as a job posting.",
};

/**
 * `null` when `url` is a capturable http(s) page. Otherwise a short,
 * scheme-specific reason suitable for direct display — always paired, in
 * the popup, with the same "paste it in the runner's Jobs page" remedy the
 * executeScript-denial fallback uses (P07 packet, "Denial/iframe
 * fallback").
 */
export function explainUnsupportedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "This page doesn't have a readable address.";
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return null;
  }

  return NAMED_REFUSAL_REASONS[parsed.protocol] ?? `${parsed.protocol}// pages can't be captured.`;
}

export function isCapturableUrl(url: string): boolean {
  return explainUnsupportedUrl(url) === null;
}
