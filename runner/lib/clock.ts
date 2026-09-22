/** Time source. Stores and the bridge take one so tests can move time (pairing expiry, leases). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock tests advance by hand. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(start: Date | string = "2026-09-22T09:00:00.000Z") {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
