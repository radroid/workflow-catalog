import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A URL-safe random secret: 32 bytes (256 bits) as base64url, 43 characters. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomUUID();
}

/** Constant-time comparison of two equal-length hex digests (false on any length mismatch). */
export function hexDigestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Constant-time check that `presented` hashes to `expectedSha256Hex`. */
export function matchesSecretHash(presented: string, expectedSha256Hex: string): boolean {
  return hexDigestsEqual(sha256Hex(presented), expectedSha256Hex);
}

/** Uniform random characters from `alphabet` (rejection-free: crypto.randomInt). */
export function randomString(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}
