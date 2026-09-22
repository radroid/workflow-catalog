import { unlink } from "node:fs/promises";
import { z } from "zod";
import type { Clock } from "../lib/clock.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Short-lived, single-use codes kept on disk, one file per code in
 * `.runner/<directory>/<sha256 of the code>.json`. The code itself is never
 * stored. Files, because the process that issues a code (`npm run setup`,
 * `npm run pair`, `npm run ui`) is not the bridge process that redeems it.
 *
 * Single use: redeeming deletes the file, and unlink(2) succeeds for exactly
 * one caller, so two simultaneous redeems of one code cannot both win.
 */
const codeRecordSchema = z
  .object({
    codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();

export type RedeemResult = "ok" | "expired" | "invalid";

export interface OneTimeCodeOptions {
  /** The state subdirectory, e.g. "pairing". */
  readonly directory: string;
  readonly ttlMs: number;
  /** A new code in canonical form. */
  readonly generate: () => string;
  /** The canonical form of what a person typed, or undefined when it cannot be a code. */
  readonly normalize: (input: string) => string | undefined;
}

export class OneTimeCodes {
  readonly #workspace: Workspace;
  readonly #clock: Clock;
  readonly #options: OneTimeCodeOptions;

  constructor(workspace: Workspace, clock: Clock, options: OneTimeCodeOptions) {
    this.#workspace = workspace;
    this.#clock = clock;
    this.#options = options;
  }

  #directory(): string[] {
    return this.#workspace.state(this.#options.directory);
  }

  #segments(name: string): string[] {
    return this.#workspace.state(this.#options.directory, name);
  }

  /** Issues a new code. Returns it in canonical form. */
  async issue(): Promise<{ canonical: string; expiresAt: Date }> {
    const canonical = this.#options.generate();
    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + this.#options.ttlMs);
    const record = codeRecordSchema.parse({
      codeSha256: sha256Hex(canonical),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    if (!(await this.#workspace.createJson(this.#segments(`${record.codeSha256}.json`), record))) {
      throw new Error("A freshly generated one-time code collided with an existing one.");
    }
    await this.purgeExpired();
    return { canonical, expiresAt };
  }

  /** Consumes a code. An expired code is consumed too, and reported as "expired". */
  async redeem(input: string): Promise<RedeemResult> {
    const canonical = this.#options.normalize(input);
    if (!canonical) return "invalid";
    const segments = this.#segments(`${sha256Hex(canonical)}.json`);
    const parsed = codeRecordSchema.safeParse(await this.#workspace.readJson(...segments).catch(() => undefined));
    if (!parsed.success) return "invalid";
    try {
      await unlink(await this.#workspace.resolveReal(...segments));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "invalid";
      throw error;
    }
    return new Date(parsed.data.expiresAt).getTime() > this.#clock.now().getTime() ? "ok" : "expired";
  }

  async #records(): Promise<Array<{ name: string; record: z.infer<typeof codeRecordSchema> | undefined }>> {
    const out: Array<{ name: string; record: z.infer<typeof codeRecordSchema> | undefined }> = [];
    for (const name of await this.#workspace.list(...this.#directory())) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const raw = await this.#workspace.readJson(...this.#segments(name)).catch(() => undefined);
      const parsed = codeRecordSchema.safeParse(raw);
      out.push({ name, record: parsed.success ? parsed.data : undefined });
    }
    return out;
  }

  /** How many codes can still be redeemed. */
  async outstanding(): Promise<number> {
    const now = this.#clock.now().getTime();
    return (await this.#records()).filter(({ record }) => record && new Date(record.expiresAt).getTime() > now).length;
  }

  /** Deletes expired or unreadable code files. */
  async purgeExpired(): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const { name, record } of await this.#records()) {
      if (!record || new Date(record.expiresAt).getTime() <= now) {
        await unlink(await this.#workspace.resolveReal(...this.#segments(name))).catch(() => undefined);
      }
    }
  }
}
