import { DAY_MS } from "../lib/clock.ts";

/**
 * Schedule timing, independent of eve. eve documents no time zone for a
 * self-hosted `eve start`/croner (docs/spec/research/eve-runtime.md §4,
 * "not documented"), and fires no catch-up of its own on a missed cron tick
 * (same section, and the P02 spike's own risk note in
 * docs/spec/research/eve-spike.md: "I found no HTTP route that reports a
 * cron fire ... P08 needs a hook or the dispatcher pattern"). P08-B's design
 * note (packet report) explains why scheduling therefore lives entirely in
 * this module, driven by the bridge's own clock, rather than eve's cron:
 * every computation here is pure and takes `now` explicitly, so a test
 * drives it with a `ManualClock`, and it never reads `process.env.TZ` or the
 * OS clock.
 */

export interface DailyCadence {
  readonly kind: "daily";
  /** 0-23, the wall-clock hour in `timeZone`. */
  readonly hour: number;
  /** 0-59. */
  readonly minute: number;
  /** An IANA zone name, e.g. "UTC". Each schedule's own, fixed (mvp-spec F10 "timezone"; not eve-documented for a self-hosted runner, so the runner defines this convention itself — see the design note). */
  readonly timeZone: string;
}

export interface WeeklyCadence {
  readonly kind: "weekly";
  /** 0 (Sunday) - 6 (Saturday), in `timeZone`. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
}

export type Cadence = DailyCadence | WeeklyCadence;

interface ZonedParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly weekday: number; // 0-6, Sunday = 0
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** `date`'s wall-clock parts in `timeZone`, via `Intl` (no new dependency; correct across DST, since the formatter itself resolves the zone's rules for that instant). */
function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday ?? "Sun"] ?? 0,
    // h23 can format local midnight as "24"; normalise it back to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * The UTC instant that reads as `year-month-day hour:minute:00` in
 * `timeZone`. `Intl` only converts instant -> wall clock, never the reverse,
 * so this finds it by a few rounds of measure-and-correct: guess an instant,
 * see what it actually reads as in the zone, and nudge by the difference.
 * Converges in at most two or three passes for any real IANA zone
 * (including half-hour offsets and a DST transition), since the only thing
 * that can move between passes is the UTC offset itself.
 */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wanted;
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const got = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = wanted - got;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/**
 * The next instant at/after `from` when `cadence` fires: its wall-clock
 * hour:minute (and weekday, for a weekly cadence) in its own time zone.
 * Never returns an instant before `from`.
 */
export function nextFireAt(cadence: Cadence, from: Date): Date {
  const zoned = zonedParts(from, cadence.timeZone);
  let candidate = zonedInstant(zoned.year, zoned.month, zoned.day, cadence.hour, cadence.minute, cadence.timeZone);
  if (cadence.kind === "weekly") {
    const daysUntil = (cadence.weekday - zoned.weekday + 7) % 7;
    candidate = new Date(candidate.getTime() + daysUntil * DAY_MS);
  }
  const step = cadence.kind === "daily" ? DAY_MS : 7 * DAY_MS;
  while (candidate.getTime() < from.getTime()) candidate = new Date(candidate.getTime() + step);
  return candidate;
}

/**
 * The most recent instant at/before `now` when `cadence` fired — the slot a
 * catch-up would run. Walks forward from two periods back so it is always
 * derived through `nextFireAt` (correct across any DST irregularity in the
 * zone, never assumed to be exactly one `step` apart in UTC).
 */
export function mostRecentFireAt(cadence: Cadence, now: Date): Date {
  const step = cadence.kind === "daily" ? DAY_MS : 7 * DAY_MS;
  let candidate = nextFireAt(cadence, new Date(now.getTime() - step * 2));
  for (;;) {
    const next = nextFireAt(cadence, new Date(candidate.getTime() + 60_000));
    if (next.getTime() > now.getTime()) return candidate;
    candidate = next;
  }
}

/**
 * A stable, human-sortable id for one fire (mvp-spec F10's "last-successful-
 * run marker per schedule"): the local calendar date (daily) or a
 * Monday-anchored week label (weekly) the fire belongs to, in the schedule's
 * own time zone — never affected by what wall-clock moment the runner
 * happens to notice it at.
 */
export function slotId(cadence: Cadence, firedAt: Date): string {
  const zoned = zonedParts(firedAt, cadence.timeZone);
  const date = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
  return cadence.kind === "daily" ? date : `week-of-${date}`;
}
