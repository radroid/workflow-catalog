import "../shared/zod-jitless";
import { sessionManifestSchema, type SessionManifest } from "@workflow-catalog/contracts";

export type ParseSessionManifestResult =
  | { ok: true; manifest: SessionManifest }
  | { ok: false; reason: string };

/**
 * File-bridge fallback, import side (P07 packet: "import
 * `application-session.json`, validate it with `SessionManifest`, and show
 * a read-only summary. Nothing opens tabs in part A."). Parses and
 * validates only — options/main.ts renders the read-only summary and never
 * calls `chrome.tabs.create`/`chrome.tabs.group` from this path.
 *
 * Treats the file as untrusted input throughout: a parse failure or a
 * schema mismatch is a plain `{ ok: false, reason }`, never a thrown
 * exception a caller could forget to catch.
 */
export function parseSessionManifestFile(jsonText: string): ParseSessionManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }

  const parsed = sessionManifestSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `That file doesn't match the session manifest shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }

  return { ok: true, manifest: parsed.data };
}
