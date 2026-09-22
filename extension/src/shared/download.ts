/**
 * Part A's only way to get a captured job (or completion events) out of the
 * extension: a Blob + `<a download>` click, from an extension page. There
 * is no `downloads` permission (not in the manifest's six), and this is
 * deliberate per the packet: "In part A, Save exports `job-capture.json`
 * via a Blob plus `<a download>` from an extension page."
 */
export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    // Not attached to the DOM: Chrome fires the download from a detached
    // anchor's synthetic click without requiring it to be visible or
    // in-document.
    anchor.click();
  } finally {
    // Revoke after the click has been dispatched; the navigation/download
    // request is already queued synchronously by then.
    URL.revokeObjectURL(url);
  }
}
