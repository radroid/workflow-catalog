import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ProfileBusyError, serialise, withProfileLock } from "../store/profile-writes.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * D8's helper on its own: the in-process chain and the cross-process lock
 * file each do a job the other can't. These tests are deterministic (no
 * timing races): each one fails if either half is removed.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("serialise", () => {
  it("runs work for one key strictly in order, and a failure doesn't stop the queue", async () => {
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const first = serialise(chains, "ws", async () => {
      await sleep(30);
      order.push("first");
    });
    const second = serialise(chains, "ws", async () => {
      order.push("second");
      throw new Error("second failed");
    });
    const third = serialise(chains, "ws", async () => {
      order.push("third");
      return 3;
    });
    await first;
    await expect(second).rejects.toThrow("second failed");
    expect(await third).toBe(3);
    expect(order).toEqual(["first", "second", "third"]);
    await sleep(0);
    expect(chains.size).toBe(0); // nothing left behind once the queue drains
  });
});

describe("withProfileLock", () => {
  it("queues a second writer in the same process on the chain, instead of leaving it to poll the lock file and give up", async () => {
    const workspace = await newWorkspace();
    const chains = new Map<string, Promise<unknown>>();
    const options = { chains, waitMs: 100 };
    const order: string[] = [];
    const slow = withProfileLock(
      workspace,
      async () => {
        order.push("slow start");
        await sleep(300); // longer than waitMs: without the chain, the second writer would time out polling the lock
        order.push("slow end");
      },
      options,
    );
    const quick = withProfileLock(
      workspace,
      async () => {
        order.push("quick");
      },
      options,
    );
    await Promise.all([slow, quick]);
    expect(order).toEqual(["slow start", "slow end", "quick"]);
  });

  it("keeps a second process out while the first holds the lock file, then lets it in", async () => {
    const workspace = await newWorkspace();
    const order: string[] = [];
    const gate = deferred();
    const processA = withProfileLock(
      workspace,
      async () => {
        order.push("A start");
        await gate.promise;
        order.push("A end");
      },
      { chains: new Map() },
    );
    await sleep(20); // A is inside its work, holding the lock
    const processB = withProfileLock(
      workspace,
      async () => {
        order.push("B start");
      },
      { chains: new Map(), waitMs: 2_000 },
    );
    await sleep(150);
    expect(order).toEqual(["A start"]); // B is waiting on the lock file, not running
    gate.resolve();
    await Promise.all([processA, processB]);
    expect(order).toEqual(["A start", "A end", "B start"]);
  });

  it("holds .runner/profile.lock only while the work runs", async () => {
    const workspace = await newWorkspace();
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    const seen = await withProfileLock(workspace, async () => JSON.parse(await readFile(lock, "utf8")) as { token: string; pid: number });
    expect(seen.pid).toBe(process.pid);
    expect(seen.token).toMatch(/^[0-9a-f-]{36}$/);
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a lock alone that someone else took over (it is not ours to remove)", async () => {
    const workspace = await newWorkspace();
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    await withProfileLock(workspace, async () => {
      await writeFile(lock, `${JSON.stringify({ token: "someone-else", pid: 1, acquiredAt: "2026-09-22T08:00:00.000Z" })}\n`);
    });
    expect(await readFile(lock, "utf8")).toContain("someone-else");
  });

  it("gives up with ProfileBusyError, without running the work, when the lock stays held", async () => {
    const workspace = await newWorkspace();
    const lock = path.join(workspace.root, ".runner", "profile.lock");
    await writeFile(lock, `${JSON.stringify({ token: "other", pid: 1, acquiredAt: new Date().toISOString() })}\n`);
    let ran = false;
    await expect(
      withProfileLock(
        workspace,
        async () => {
          ran = true;
        },
        { waitMs: 100 },
      ),
    ).rejects.toThrow(ProfileBusyError);
    expect(ran).toBe(false);
  });
});
