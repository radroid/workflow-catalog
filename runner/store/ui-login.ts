import { MINUTE_MS, type Clock } from "../lib/clock.ts";
import { randomSecret } from "../lib/crypto.ts";
import { OneTimeCodes, type RedeemResult } from "./one-time-codes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * One-time sign-in links for the runner's local UI. `npm run runner` prints
 * one at start and `npm run ui` prints a fresh one at any time:
 *
 *   http://127.0.0.1:4310/ui/login?nonce=<43 characters>
 *
 * Opening it sets the local-UI cookie (server/local-ui.ts). A nonce is valid
 * for 10 minutes and works once. Files under `.runner/ui-login/`, named by
 * sha256, like pairing codes.
 */
export const UI_LOGIN_TTL_MS = 10 * MINUTE_MS;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class UiLoginLinks {
  readonly #codes: OneTimeCodes;

  constructor(workspace: Workspace, clock: Clock) {
    this.#codes = new OneTimeCodes(workspace, clock, {
      directory: "ui-login",
      ttlMs: UI_LOGIN_TTL_MS,
      generate: () => randomSecret(32),
      normalize: (input) => (NONCE_PATTERN.test(input) ? input : undefined),
    });
  }

  /** A new sign-in URL for the given bridge origin. */
  async issue(origin: string): Promise<{ url: string; expiresAt: Date }> {
    const { canonical, expiresAt } = await this.#codes.issue();
    return { url: `${origin}/ui/login?nonce=${canonical}`, expiresAt };
  }

  redeem(nonce: string): Promise<RedeemResult> {
    return this.#codes.redeem(nonce);
  }
}
