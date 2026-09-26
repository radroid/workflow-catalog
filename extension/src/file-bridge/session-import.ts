import "../shared/zod-jitless";
import { MAX_BRIDGE_BODY_BYTES, sessionManifestSchema, type SessionManifest } from "@workflow-catalog/contracts";

export type ParseSessionManifestResult =
  | { ok: true; manifest: SessionManifest }
  | { ok: false; summary: string; detail?: string };

export type FileSizeCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Review issue 3 (medium-low): a 20 MB valid manifest froze the options
 * page for ~160s reading it in unchecked (gate 7). Checked against
 * `file.size` *before* `file.text()` is ever called, so an oversized file
 * is refused without reading a single byte of it.
 */
export function checkImportFileSize(byteLength: number): FileSizeCheckResult {
  if (byteLength > MAX_BRIDGE_BODY_BYTES) {
    return {
      ok: false,
      reason: `That file is too large to import (${byteLength.toLocaleString()} bytes; the limit is ${MAX_BRIDGE_BODY_BYTES.toLocaleString()} bytes).`,
    };
  }
  return { ok: true };
}

/**
 * File-bridge fallback, import side (P07 packet: "import
 * `application-session.json`, validate it with `SessionManifest`, and show
 * a read-only summary. Nothing opens tabs in part A."). Parses and
 * validates only — options/main.ts renders the read-only summary and never
 * calls `chrome.tabs.create`/`chrome.tabs.group` from this path.
 *
 * Treats the file as untrusted input throughout: a parse failure or a
 * schema mismatch is a plain `{ ok: false, ... }`, never a thrown
 * exception a caller could forget to catch.
 *
 * The failure shape is `{ summary, detail? }` rather than one long joined
 * string (review fold-in i: "Turn zod issue dumps into one plain
 * sentence, keeping the detail in a <details> element") — `summary` is
 * always a short, plain sentence fit to show directly; `detail`, when
 * present, is the full issue-by-issue breakdown options/main.ts puts
 * inside a collapsed `<details>` rather than dumping inline.
 */
export function parseSessionManifestFile(jsonText: string): ParseSessionManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, summary: "That file isn't valid JSON." };
  }

  const parsed = sessionManifestSchema.safeParse(data);
  if (!parsed.success) {
    const count = parsed.error.issues.length;
    return {
      ok: false,
      summary: `That file doesn't match the session manifest shape (${count} problem${count === 1 ? "" : "s"}).`,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n"),
    };
  }

  return { ok: true, manifest: parsed.data };
}
