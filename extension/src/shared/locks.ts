/**
 * Cross-context mutual exclusion for read-modify-write of extension
 * storage (P07 part C).
 *
 * The popup, the options page, the side panel and the service worker are
 * separate JS contexts that share only `chrome.storage`, which has no
 * compare-and-set. The Web Locks API (`navigator.locks`) is shared by every
 * context of one origin, the service worker included, so a lock taken here
 * serialises the same work in all of them. A lock is released when the
 * context holding it goes away, which is also how the side panel tells a
 * live opening from one a killed context left behind (`isLockFree`).
 *
 * happy-dom (the unit tests) has no `navigator.locks`; there, an
 * in-process queue per name stands in, with the same ordering inside the
 * one context a unit test runs in.
 */

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
};

function lockManager(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks;
}

const localTails = new Map<string, Promise<unknown>>();
const localHeld = new Set<string>();

function runLocally<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = localTails.get(name) ?? Promise.resolve();
  const run = previous.then(
    async () => {
      localHeld.add(name);
      try {
        return await work();
      } finally {
        localHeld.delete(name);
      }
    },
    async () => {
      localHeld.add(name);
      try {
        return await work();
      } finally {
        localHeld.delete(name);
      }
    },
  );
  const tail = run.catch(() => undefined);
  localTails.set(name, tail);
  void tail.then(() => {
    if (localTails.get(name) === tail) localTails.delete(name);
  });
  return run;
}

/** Runs `work` while holding the lock `name`, waiting for it if another
 * context holds it. */
export function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks) return locks.request(name, () => work());
  return runLocally(name, work);
}

/** Runs `work` holding `name` only if nobody holds it now. `acquired:
 * false` means another context (or this one) holds it. */
export async function withLockIfFree<T>(name: string, work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const locks = lockManager();
  if (locks) {
    return locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false as const };
      return { acquired: true as const, value: await work() };
    });
  }
  if (localHeld.has(name) || localTails.has(name)) return { acquired: false };
  return { acquired: true, value: await runLocally(name, work) };
}

/** True when no context holds `name` right now. */
export async function isLockFree(name: string): Promise<boolean> {
  const probe = await withLockIfFree(name, async () => true);
  return probe.acquired;
}
