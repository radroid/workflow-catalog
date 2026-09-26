/**
 * `contentHash` per `packages/contracts/src/job-snapshot.ts`: "Lowercase hex
 * SHA-256 of `text` encoded as UTF-8, exactly as stored (no trimming or
 * normalization)." Computed via Web Crypto (`crypto.subtle`), available in
 * both the extension-page contexts (popup/options/sidepanel) and the MV3
 * service worker.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
