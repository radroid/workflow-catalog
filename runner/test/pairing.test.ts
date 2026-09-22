import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock, MINUTE_MS } from "../lib/clock.ts";
import { COMMAND_LEASE_MS, CommandQueue } from "../store/commands.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { PAIRING_CODE_TTL_MS, PairingCodes, formatPairingCode, normalizePairingCode } from "../store/pairing.ts";
import { UiLoginLinks } from "../store/ui-login.ts";
import { EXTENSION_ORIGIN, newWorkspace } from "./helpers.ts";

describe("pairing codes", () => {
  it("expires at 10 minutes: valid one millisecond before, expired at the mark", async () => {
    expect(PAIRING_CODE_TTL_MS).toBe(10 * MINUTE_MS);
    const clock = new ManualClock();
    const codes = new PairingCodes(await newWorkspace(clock), clock);
    const early = await codes.issue();
    clock.advance(10 * MINUTE_MS - 1);
    expect(await codes.redeem(early.code)).toBe("ok");
    const late = await codes.issue();
    clock.advance(10 * MINUTE_MS);
    expect(await codes.redeem(late.code)).toBe("expired");
    // An expired code is consumed too.
    expect(await codes.redeem(late.code)).toBe("invalid");
  });

  it("is single use, even when redeems race (APFS lets concurrent unlinks all succeed)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const codes = new PairingCodes(workspace, clock);
    for (let round = 0; round < 20; round += 1) {
      const { code } = await codes.issue();
      const results = await Promise.all([codes.redeem(code), codes.redeem(code), codes.redeem(code), codes.redeem(code)]);
      expect(results.filter((result) => result === "ok")).toHaveLength(1);
      expect(await codes.redeem(code)).toBe("invalid");
    }
    expect(await codes.outstanding()).toBe(0);
    expect(await workspace.list(".runner", "pairing")).toEqual([]);
  });

  it("is short, unambiguous, and forgiving about how it is typed", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const codes = new PairingCodes(workspace, clock);
    const { code } = await codes.issue();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(code.length).toBeLessThanOrEqual(12);
    expect(await codes.redeem(` ${code.toLowerCase().replace("-", " ")} `)).toBe("ok");
    expect(normalizePairingCode("o1l1i-abcde")).toBe("01111ABCDE");
    expect(normalizePairingCode("UUUUU-UUUUU")).toBeUndefined();
    expect(normalizePairingCode("A".repeat(65))).toBeUndefined();
    expect(formatPairingCode("0123456789")).toBe("01234-56789");
    // The code itself is never stored, only its hash.
    const second = await codes.issue();
    const files = await workspace.list(".runner", "pairing");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.stringify(await workspace.readJson(".runner", "pairing", files[0] ?? ""))).not.toContain(second.code.replace("-", ""));
  });

  it("purges expired codes when a new one is issued", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const codes = new PairingCodes(workspace, clock);
    await codes.issue();
    await codes.issue();
    clock.advance(PAIRING_CODE_TTL_MS);
    await codes.issue();
    expect(await workspace.list(".runner", "pairing")).toHaveLength(1);
    expect(await codes.outstanding()).toBe(1);
  });
});

describe("devices", () => {
  it("revocation removes the device and its token stops authenticating", async () => {
    const clock = new ManualClock();
    const devices = new DeviceRegistry(await newWorkspace(clock), clock);
    const { device, token } = await devices.register(EXTENSION_ORIGIN);
    expect((await devices.authenticate(token))?.deviceId).toBe(device.deviceId);
    expect(await devices.revoke(device.deviceId)).toBe(true);
    expect(await devices.list()).toEqual([]);
    expect(await devices.authenticate(token)).toBeUndefined();
    expect(await devices.revoke(device.deviceId)).toBe(false);
    expect(await devices.revoke("../../workspace")).toBe(false);
  });

  it("only accepts a chrome-extension origin", async () => {
    const clock = new ManualClock();
    const devices = new DeviceRegistry(await newWorkspace(clock), clock);
    await expect(devices.register("https://jobs.example")).rejects.toThrow();
  });
});

describe("UI sign-in links", () => {
  it("work once, for 10 minutes", async () => {
    const clock = new ManualClock();
    const links = new UiLoginLinks(await newWorkspace(clock), clock);
    const { url } = await links.issue("http://127.0.0.1:4310");
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await links.redeem(nonce)).toBe("ok");
    expect(await links.redeem(nonce)).toBe("invalid");
    const second = new URL((await links.issue("http://127.0.0.1:4310")).url).searchParams.get("nonce") ?? "";
    clock.advance(10 * MINUTE_MS);
    expect(await links.redeem(second)).toBe("expired");
  });
});

describe("command queue", () => {
  it("leases per device, re-delivers after the lease, and retires on acknowledgement", async () => {
    const clock = new ManualClock();
    const queue = new CommandQueue(await newWorkspace(clock), clock);
    const deviceId = randomUUID();
    const command = {
      protocol: 1 as const,
      type: "open_application_group" as const,
      commandId: randomUUID(),
      deviceId,
      sessionId: randomUUID(),
      workflowVersion: "job-assistant@0",
      expiresAt: "2026-09-22T12:00:00.000Z",
      payload: { title: "Fernwood application", items: [{ taskId: randomUUID(), jobRevision: 1, url: "https://jobs.example/fernwood/apply" }] },
    };
    expect(await queue.enqueue(command)).toBe(true);
    expect(await queue.enqueue(command)).toBe(false);
    expect(await queue.leasePending(randomUUID())).toEqual([]);
    const both = await Promise.all([queue.leasePending(deviceId), queue.leasePending(deviceId)]);
    expect(both.flat()).toHaveLength(1);
    clock.advance(COMMAND_LEASE_MS);
    expect(await queue.leasePending(deviceId)).toHaveLength(1);
    expect((await queue.get(command.commandId))?.deliveries).toBe(2);
    expect(await queue.acknowledge(command.commandId, randomUUID())).toBe(false);
    expect(await queue.acknowledge(command.commandId, deviceId)).toBe(true);
    clock.advance(COMMAND_LEASE_MS);
    expect(await queue.leasePending(deviceId)).toEqual([]);
    expect(await queue.leasePending(deviceId, { since: new Date("2026-09-23T00:00:00.000Z") })).toEqual([]);
  });

  it("refuses a command that breaks the contract", async () => {
    const clock = new ManualClock();
    const queue = new CommandQueue(await newWorkspace(clock), clock);
    await expect(queue.enqueue({ type: "open_application_group" } as never)).rejects.toThrow();
  });
});
