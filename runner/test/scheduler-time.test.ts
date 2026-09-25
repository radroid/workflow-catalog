import { describe, expect, it } from "vitest";
import { mostRecentFireAt, nextFireAt, slotId, type Cadence } from "../scheduler/time.ts";

const DAILY_UTC: Cadence = { kind: "daily", hour: 9, minute: 0, timeZone: "UTC" };
const WEEKLY_UTC: Cadence = { kind: "weekly", weekday: 1, hour: 9, minute: 0, timeZone: "UTC" }; // Monday
// A non-UTC IANA zone (design note: "each schedule's time zone, and how a test proves it with an injected
// clock"), picked because it's a fixed +05:30 offset with no DST, so the fire time is easy to hand-verify.
const DAILY_IST: Cadence = { kind: "daily", hour: 9, minute: 0, timeZone: "Asia/Kolkata" };

describe("scheduler/time.ts: nextFireAt", () => {
  it("daily UTC: before today's fire time returns today's", () => {
    expect(nextFireAt(DAILY_UTC, new Date("2026-09-25T08:00:00.000Z"))).toEqual(new Date("2026-09-25T09:00:00.000Z"));
  });

  it("daily UTC: after today's fire time returns tomorrow's", () => {
    expect(nextFireAt(DAILY_UTC, new Date("2026-09-25T09:30:00.000Z"))).toEqual(new Date("2026-09-26T09:00:00.000Z"));
  });

  it("daily UTC: exactly at the fire time returns that instant (never before `from`)", () => {
    expect(nextFireAt(DAILY_UTC, new Date("2026-09-25T09:00:00.000Z"))).toEqual(new Date("2026-09-25T09:00:00.000Z"));
  });

  it("weekly UTC: before Monday 09:00 in the same week returns that Monday", () => {
    // 2026-09-21 is a Monday.
    expect(nextFireAt(WEEKLY_UTC, new Date("2026-09-20T00:00:00.000Z"))).toEqual(new Date("2026-09-21T09:00:00.000Z"));
  });

  it("weekly UTC: after this Monday's fire returns next Monday", () => {
    expect(nextFireAt(WEEKLY_UTC, new Date("2026-09-21T10:00:00.000Z"))).toEqual(new Date("2026-09-28T09:00:00.000Z"));
  });

  it("Asia/Kolkata (UTC+5:30, no DST): 09:00 local is 03:30 UTC", () => {
    expect(nextFireAt(DAILY_IST, new Date("2026-09-25T00:00:00.000Z"))).toEqual(new Date("2026-09-25T03:30:00.000Z"));
    // Just after the fire, local time: rolls to the next day, still 03:30 UTC.
    expect(nextFireAt(DAILY_IST, new Date("2026-09-25T03:31:00.000Z"))).toEqual(new Date("2026-09-26T03:30:00.000Z"));
  });
});

describe("scheduler/time.ts: mostRecentFireAt", () => {
  it("daily UTC: mid-afternoon finds this morning's fire", () => {
    expect(mostRecentFireAt(DAILY_UTC, new Date("2026-09-25T15:00:00.000Z"))).toEqual(new Date("2026-09-25T09:00:00.000Z"));
  });

  it("daily UTC: before today's fire finds yesterday's", () => {
    expect(mostRecentFireAt(DAILY_UTC, new Date("2026-09-25T08:59:00.000Z"))).toEqual(new Date("2026-09-24T09:00:00.000Z"));
  });

  it("daily UTC: several missed days later still finds only the single latest fire", () => {
    // The runner was down 2026-09-20 through 2026-09-24; started back up on the 25th.
    expect(mostRecentFireAt(DAILY_UTC, new Date("2026-09-25T12:00:00.000Z"))).toEqual(new Date("2026-09-25T09:00:00.000Z"));
  });

  it("weekly UTC: finds last Monday's fire mid-week", () => {
    expect(mostRecentFireAt(WEEKLY_UTC, new Date("2026-09-24T12:00:00.000Z"))).toEqual(new Date("2026-09-21T09:00:00.000Z"));
  });
});

describe("scheduler/time.ts: slotId", () => {
  it("daily: the local calendar date the fire belongs to", () => {
    expect(slotId(DAILY_UTC, new Date("2026-09-25T09:00:00.000Z"))).toBe("2026-09-25");
  });

  it("daily, non-UTC zone: the fire's *local* date, not UTC's", () => {
    // 2026-09-26T03:30Z is 2026-09-26 09:00 in Asia/Kolkata (local date matches here); pick an instant that
    // differs in UTC vs. Kolkata to prove the zone is actually consulted.
    expect(slotId(DAILY_IST, new Date("2026-09-25T20:00:00.000Z"))).toBe("2026-09-26"); // 01:30 next day in Kolkata
  });

  it("weekly: a stable, Monday-anchored label", () => {
    expect(slotId(WEEKLY_UTC, new Date("2026-09-21T09:00:00.000Z"))).toBe("week-of-2026-09-21");
  });

  it("two fires in the same slot get the same id (idempotency-key stability)", () => {
    const first = slotId(DAILY_UTC, new Date("2026-09-25T09:00:01.000Z"));
    const second = slotId(DAILY_UTC, new Date("2026-09-25T09:04:00.000Z"));
    expect(first).toBe(second);
  });
});
