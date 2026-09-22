import { MINUTE_MS, type Clock } from "../lib/clock.ts";
import { randomString } from "../lib/crypto.ts";
import { OneTimeCodes, type RedeemResult } from "./one-time-codes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Pairing codes: short, typed by a person into the extension's options page,
 * valid for 10 minutes, usable once (browser-boundary.md "Pairing and token
 * handling"). `npm run setup` or `npm run pair` issues one; `POST /pair`
 * redeems it. Stored as one file per code under `.runner/pairing/`, named by
 * the code's sha256 (store/one-time-codes.ts).
 *
 * Format: 10 characters from Crockford's base32 alphabet (no I, L, O or U),
 * shown as two groups of five, "7KQ2M-X9RTB" (11 characters, 50 bits).
 * Redeeming ignores case, spaces and the hyphen, and reads O as 0 and I or L
 * as 1, so a code copied by hand still works.
 */
export const PAIRING_CODE_TTL_MS = 10 * MINUTE_MS;
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 10;
export type { RedeemResult };

/** Canonical 10-character form, or undefined when the input cannot be a pairing code. */
export function normalizePairingCode(input: string): string | undefined {
  if (input.length > 64) return undefined;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const char of cleaned) if (!PAIRING_CODE_ALPHABET.includes(char)) return undefined;
  return cleaned;
}

export function formatPairingCode(canonical: string): string {
  return `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
}

export class PairingCodes {
  readonly #codes: OneTimeCodes;

  constructor(workspace: Workspace, clock: Clock) {
    this.#codes = new OneTimeCodes(workspace, clock, {
      directory: "pairing",
      ttlMs: PAIRING_CODE_TTL_MS,
      generate: () => randomString(PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH),
      normalize: normalizePairingCode,
    });
  }

  /** Issues a new code, valid for 10 minutes. Returns it formatted for display. */
  async issue(): Promise<{ code: string; expiresAt: Date }> {
    const { canonical, expiresAt } = await this.#codes.issue();
    return { code: formatPairingCode(canonical), expiresAt };
  }

  /** Consumes a code. "expired" still consumes it. */
  redeem(input: string): Promise<RedeemResult> {
    return this.#codes.redeem(input);
  }

  /** Codes that can still be redeemed. */
  outstanding(): Promise<number> {
    return this.#codes.outstanding();
  }

  /** Withdraws every outstanding code issued at or before `instant` (the bridge's guess budget). */
  revokeIssuedAtOrBefore(instant: Date): Promise<number> {
    return this.#codes.revokeIssuedAtOrBefore(instant);
  }

  purgeExpired(): Promise<void> {
    return this.#codes.purgeExpired();
  }
}
