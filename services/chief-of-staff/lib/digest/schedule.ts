import { clockParts } from "@lares/agent-kit/owner-clock";

/** The home clock, and now only a default — see `dueScheduledSlot`. */
export const TZ = "Europe/Oslo";

/** { date, hour, minute } for `d` read in `tz`. Delegates to the kit's `clockParts` (ORB-193) so
 *  this file, the proactivity gate's quiet hours and every other slot in the fleet read ONE
 *  formatter; the local `Intl.DateTimeFormat` this used to carry was the fourth copy. */
export function osloParts(d: Date, tz: string = TZ): { date: string; hour: number; minute: number } {
  const { date, hour, minute } = clockParts(d, tz);
  return { date, hour, minute };
}

/**
 * A slot key for the current scheduled run, or null if `now` is not in a scheduled minute.
 *
 * ORB-193 — `tz` is the OWNER's timezone, resolved per tick by the schedule (`ownerTz()`). At home
 * that is `Europe/Oslo` and the 09:00/17:00 slots are exactly the ones this has always returned;
 * on a trip the digest lands at 09:00 where he actually is. `hours` moved to the THIRD argument
 * when `tz` was added, so a caller that passed hours explicitly had to pass `tz` before them.
 *
 * LAR-17-s3 — `hours` is now REQUIRED, not defaulted to `[9, 17]`: the digest's hours are a
 * setting (`packages/agent-kit/src/schedule-settings.ts`'s `SCHEDULE_HOUR_DEFAULTS.digest`), and
 * a default living here too would be a second place the same fact could drift from the first.
 * The caller (`agent/schedules/digest.ts`) reads the setting, through `lib/schedule-hours.ts`'s
 * cache, and always has an hours array to hand — see `readScheduleHours`'s own contract for why
 * that read can never come back empty.
 */
export function dueScheduledSlot(now: Date, tz: string, hours: number[]): string | null {
  const { date, hour, minute } = osloParts(now, tz);
  if (minute === 0 && hours.includes(hour)) return `${date}T${hour}`;
  return null;
}

/**
 * Read a scheduled-slot hour out of an environment variable.
 *
 * `Number("8pm")` is NaN, and `dueScheduledSlot(now, tz, [NaN])` matches no hour that will ever
 * exist — so a typo in one env var silently turns a daily message off forever, while the
 * boot log still says "armed". Silent failure claiming success is this project's signature
 * defect; this is the one line that closes it for every slot lane.
 *
 * Returns the fallback plus the offending raw value, so the caller can log what it rejected.
 * The caller logs rather than this function, because "what is a bad value worth saying about"
 * is the caller's business and a pure return is testable without capturing a console.
 */
export function parseSlotHour(raw: string | undefined, fallback: number): { hour: number; invalid?: string } {
  if (raw === undefined || raw.trim() === "") return { hour: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return { hour: fallback, invalid: raw };
  return { hour: n };
}

/**
 * Read a positive-integer env var (an interval in ms, a daily cap, a timeout) defensively —
 * the same shape as parseSlotHour, generalised past the 0–23 hour range.
 *
 * `Number("bad")` is NaN, and NaN is never "off": `setInterval` clamps a NaN delay to 1ms — a
 * continuous loop, not a paused one — and a NaN cap breaks `>=`/`<=` comparisons silently
 * rather than visibly. Falling back to a known-good default, and handing back what was
 * rejected so the caller can log it, is parseSlotHour's own fix applied to anything else that
 * must never be allowed to become NaN.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): { value: number; invalid?: string } {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { value: fallback, invalid: raw };
  return { value: n };
}
