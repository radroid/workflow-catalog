// Web Crypto only (globalThis.crypto) — no `node:crypto` import. This module
// is used from proxy.ts (which must stay runtime-agnostic; Next 16 defaults
// Proxy to the Node.js runtime, but Web Crypto works identically there, in
// an Edge runtime, and in the Vitest/Node test environment), and from server
// actions and route handlers. One primitive set everywhere.

const textEncoder = new TextEncoder();

/** Generates a random token, base64url-encoded, at least 128 bits of entropy. */
export function randomToken(byteLength = 20): string {
  // 20 bytes = 160 bits, comfortably over the 128-bit floor.
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** HMAC-SHA256 of `message` keyed by `secret`, returned base64url-encoded. */
export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Verifies an HMAC-SHA256 signature via `crypto.subtle.verify`, which does
 * its own constant-time comparison internally — this never does a plain
 * string/byte compare of the signature itself.
 */
export async function hmacVerify(secret: string, message: string, signatureB64Url: string): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signatureB64Url);
  } catch {
    return false;
  }
  const key = await importHmacKey(secret);
  return crypto.subtle.verify("HMAC", key, toArrayBuffer(signatureBytes), textEncoder.encode(message));
}

/**
 * Constant-time string equality: the loop always runs to the longer input's
 * length and folds every byte comparison (plus the length difference) into
 * one accumulator, so neither early mismatch nor length is observable via
 * branch timing the way a short-circuiting `===`/`localeCompare` would be.
 * Used for the owner-secret check, which (unlike the session cookie) is
 * compared directly rather than verified as a MAC.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i++) {
    const x = i < aBytes.length ? aBytes[i]! : 0;
    const y = i < bBytes.length ? bBytes[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
