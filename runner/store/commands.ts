import { openApplicationGroupSchema, type OpenApplicationGroup } from "@workflow-catalog/contracts";
import { z } from "zod";
import { MINUTE_MS, type Clock } from "../lib/clock.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The command queue behind `GET /commands`: runner → extension commands, one
 * file per command in `.runner/commands/<commandId>.json`. P02 ships the queue
 * and the lease semantics; it is empty until P06 enqueues
 * `open_application_group` commands from a session.
 *
 * - Device-scoped: a device only ever receives commands addressed to its own
 *   deviceId (identity comes from its bearer token, never from the request).
 * - Expiring: a command past its `expiresAt` is never delivered.
 * - Leased: delivering a command leases it to that device for LEASE_MS. While
 *   the lease holds, polls do not return it again; once it lapses without an
 *   acknowledgement, the next poll re-delivers it (at-least-once; the
 *   extension de-duplicates by commandId).
 * - Acknowledged: `acknowledge()` (P06, on `browser_command_result`) retires
 *   it for good.
 */
export const COMMAND_LEASE_MS = 5 * MINUTE_MS;

const commandRecordSchema = z
  .object({
    command: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    lease: z.object({ until: z.string() }).strict().optional(),
    deliveries: z.number().int().nonnegative(),
    acknowledgedAt: z.string().optional(),
  })
  .strict();
export type CommandRecord = Omit<z.infer<typeof commandRecordSchema>, "command"> & { readonly command: OpenApplicationGroup };

export interface LeaseOptions {
  /** Only commands created at or after this instant (the `since` query parameter). */
  readonly since?: Date;
}

export class CommandQueue {
  readonly #workspace: Workspace;
  readonly #clock: Clock;
  readonly #leaseMs: number;
  /** Serialises read-modify-write in this process, so two polls cannot lease one command twice. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(workspace: Workspace, clock: Clock, leaseMs = COMMAND_LEASE_MS) {
    this.#workspace = workspace;
    this.#clock = clock;
    this.#leaseMs = leaseMs;
  }

  #segments(commandId: string): string[] {
    return this.#workspace.state("commands", `${z.uuid().parse(commandId)}.json`);
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #read(commandId: string): Promise<CommandRecord | undefined> {
    const raw = await this.#workspace.readJson(...this.#segments(commandId));
    if (raw === undefined) return undefined;
    return commandRecordSchema.parse(raw) as CommandRecord;
  }

  /** Queues a command (validated against the contract). False when that commandId is already queued. */
  async enqueue(command: OpenApplicationGroup): Promise<boolean> {
    const valid = openApplicationGroupSchema.parse(command);
    const record: CommandRecord = { command: valid, createdAt: this.#clock.now().toISOString(), deliveries: 0 };
    return this.#workspace.createJson(this.#segments(valid.commandId), record);
  }

  async get(commandId: string): Promise<CommandRecord | undefined> {
    return this.#read(commandId);
  }

  async list(): Promise<CommandRecord[]> {
    const records: CommandRecord[] = [];
    for (const name of await this.#workspace.list(...this.#workspace.state("commands"))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const record = await this.#read(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The pending commands for a device, leased to it now. */
  async leasePending(deviceId: string, options: LeaseOptions = {}): Promise<OpenApplicationGroup[]> {
    return this.#exclusive(async () => {
      const now = this.#clock.now();
      const leased: OpenApplicationGroup[] = [];
      for (const record of await this.list()) {
        const { command } = record;
        if (command.deviceId !== deviceId) continue;
        if (record.acknowledgedAt) continue;
        if (new Date(command.expiresAt).getTime() <= now.getTime()) continue;
        if (options.since && new Date(record.createdAt).getTime() < options.since.getTime()) continue;
        if (record.lease && new Date(record.lease.until).getTime() > now.getTime()) continue;
        const next: CommandRecord = {
          ...record,
          lease: { until: new Date(now.getTime() + this.#leaseMs).toISOString() },
          deliveries: record.deliveries + 1,
        };
        await this.#workspace.writeJson(this.#segments(command.commandId), next);
        leased.push(command);
      }
      return leased;
    });
  }

  /** Retires a command for good. Only the device it was addressed to can acknowledge it. */
  async acknowledge(commandId: string, deviceId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const record = await this.#read(commandId);
      if (!record || record.command.deviceId !== deviceId) return false;
      if (record.acknowledgedAt) return true;
      await this.#workspace.writeJson(this.#segments(commandId), { ...record, acknowledgedAt: this.#clock.now().toISOString() });
      return true;
    });
  }
}
