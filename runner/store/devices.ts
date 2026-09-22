import { unlink } from "node:fs/promises";
import { z } from "zod";
import { DAY_MS, type Clock } from "../lib/clock.ts";
import { matchesSecretHash, newId, randomSecret, sha256Hex } from "../lib/crypto.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Paired devices: one file per device in `.runner/devices/<deviceId>.json`.
 * The bearer token is shown to the extension once, in the `POST /pair`
 * response, and only its sha256 is stored. Revoking a device deletes its
 * file, and the bridge reads this directory on every request, so a revoked
 * token stops working on the very next call.
 */

/** A Chrome extension origin: `chrome-extension://` plus a 32-letter ID in a–p. */
export const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

/** Device tokens are device-scoped and short-lived (browser-boundary.md); the extension re-pairs after this. */
export const DEVICE_TOKEN_TTL_MS = 30 * DAY_MS;

/** 32 random bytes as base64url. */
export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const deviceRecordSchema = z
  .object({
    deviceId: z.uuid(),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
    origin: z.string().regex(EXTENSION_ORIGIN_PATTERN),
    pairedAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export class DeviceRegistry {
  readonly #workspace: Workspace;
  readonly #clock: Clock;

  constructor(workspace: Workspace, clock: Clock) {
    this.#workspace = workspace;
    this.#clock = clock;
  }

  #segments(deviceId: string): string[] {
    return this.#workspace.state("devices", `${z.uuid().parse(deviceId)}.json`);
  }

  /** Registers a device for an extension origin and returns its one-time-visible token. */
  async register(origin: string): Promise<{ device: DeviceRecord; token: string }> {
    if (!EXTENSION_ORIGIN_PATTERN.test(origin)) throw new Error(`Not a Chrome extension origin: ${origin}`);
    const token = randomSecret(32);
    const now = this.#clock.now();
    const device = deviceRecordSchema.parse({
      deviceId: newId(),
      tokenSha256: sha256Hex(token),
      origin,
      pairedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEVICE_TOKEN_TTL_MS).toISOString(),
    });
    const created = await this.#workspace.createJson(this.#segments(device.deviceId), device);
    if (!created) throw new Error(`Device ${device.deviceId} already exists.`);
    return { device, token };
  }

  /** Every stored device, expired ones included, oldest first. */
  async list(): Promise<DeviceRecord[]> {
    const devices: DeviceRecord[] = [];
    for (const name of await this.#workspace.list(...this.#workspace.state("devices"))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = deviceRecordSchema.safeParse(await this.#workspace.readJson(...this.#workspace.state("devices", name)));
      if (parsed.success) devices.push(parsed.data);
    }
    return devices.sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
  }

  isActive(device: DeviceRecord): boolean {
    return new Date(device.expiresAt).getTime() > this.#clock.now().getTime();
  }

  /** Paired devices whose token has not expired. */
  async active(): Promise<DeviceRecord[]> {
    return (await this.list()).filter((device) => this.isActive(device));
  }

  /** The active device a bearer token belongs to, or undefined. Compares hashes in constant time. */
  async authenticate(token: string): Promise<DeviceRecord | undefined> {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return undefined;
    let match: DeviceRecord | undefined;
    for (const device of await this.list()) {
      if (matchesSecretHash(token, device.tokenSha256)) match = device;
    }
    return match && this.isActive(match) ? match : undefined;
  }

  /** Removes a device. Its token fails on the next request. Returns false when there was no such device. */
  async revoke(deviceId: string): Promise<boolean> {
    if (!z.uuid().safeParse(deviceId).success) return false;
    try {
      await unlink(await this.#workspace.resolveReal(...this.#segments(deviceId)));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
