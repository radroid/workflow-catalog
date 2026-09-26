import { describe, expect, it } from "vitest";
import { isLockFree, withLock, withLockIfFree } from "./locks";

describe("locks (the in-process stand-in the unit tests run on; the e2e runs on navigator.locks)", () => {
  it("runs work under one name one at a time, in the order it asked", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withLock("a", async () => {
      order.push("first start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first end");
    });
    const second = withLock("a", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("different names don't wait for each other", async () => {
    let release!: () => void;
    const held = withLock("b", () => new Promise<void>((resolve) => (release = resolve)));
    expect(await withLock("c", async () => "free")).toBe("free");
    release();
    await held;
  });

  it("withLockIfFree refuses while the lock is held, and isLockFree says so", async () => {
    let release!: () => void;
    const held = withLock("d", () => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    expect(await withLockIfFree("d", async () => "ran")).toEqual({ acquired: false });
    expect(await isLockFree("d")).toBe(false);
    release();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await isLockFree("d")).toBe(true);
    expect(await withLockIfFree("d", async () => "ran")).toEqual({ acquired: true, value: "ran" });
  });

  it("a failing holder releases the lock", async () => {
    await expect(withLock("e", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock("e", async () => "next")).toBe("next");
  });
});
