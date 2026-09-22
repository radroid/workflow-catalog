import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { z } from "zod";
import { MINUTE_MS, type Clock } from "../lib/clock.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Short-lived, single-use codes kept on disk, one file per code in
 * `.runner/<directory>/<sha256 of the code>.json`. The code itself is never
 * stored. Files, because the process that issues a code (`npm run setup`,
 * `npm run pair`, `npm run ui`) is not the bridge process that redeems it.
 *
 * Single use: redeeming first renames the file to a name unique to this
 * attempt, and only the caller whose rename succeeds may use the code. Not
 * unlink(2): on macOS (APFS) several concurrent unlinks of one path can all
 * succeed, so "whoever deleted it" is not a safe claim (seen in this
 * package's race test). rename(2) of one source to distinct targets lets
 * exactly one caller win.
 */
const codeRecordSchema = z
  .object({
    codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();

export type RedeemResult = "ok" | "expired" | "invalid";

const CLAIM_SUFFIX = ".claimed";
/** A claim file older than this was left by a crash between claim and delete. */
const STALE_CLAIM_MS = MINUTE_MS;

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
    const file = await this.#workspace.resolveReal(...this.#segments(`${sha256Hex(canonical)}.json`));
    const claimed = `${file}.${randomBytes(8).toString("hex")}${CLAIM_SUFFIX}`;
    try {
      await rename(file, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "invalid";
      throw error;
    }
    try {
      const parsed = codeRecordSchema.safeParse(JSON.parse(await readFile(claimed, "utf8")));
      if (!parsed.success) return "invalid";
      return new Date(parsed.data.expiresAt).getTime() > this.#clock.now().getTime() ? "ok" : "expired";
    } catch {
      return "invalid";
    } finally {
      await unlink(claimed).catch(() => undefined);
    }
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

  /** Deletes expired or unreadable code files, and claims a crash left behind. */
  async purgeExpired(): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const { name, record } of await this.#records()) {
      if (!record || new Date(record.expiresAt).getTime() <= now) {
        await unlink(await this.#workspace.resolveReal(...this.#segments(name))).catch(() => undefined);
      }
    }
    for (const name of await this.#workspace.list(...this.#directory())) {
      if (!name.endsWith(CLAIM_SUFFIX)) continue;
      const file = await this.#workspace.resolveReal(...this.#segments(name));
      const info = await stat(file).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > STALE_CLAIM_MS) await unlink(file).catch(() => undefined);
    }
  }
}
