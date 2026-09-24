/**
 * nextOccurrence — compute the next due Date for a reminder recurrence string.
 *
 * Ported from `services/agent-runtime/lib/adapters/reminders/recurrence.ts`, which in turn
 * reuses Oslo-timezone helpers from that package's `reminders/parse.ts`. Those two files pull
 * in a large natural-language time parser (`parseWhen`) that Task 10 deliberately does NOT
 * port (see `agent/tools/remind_set.ts`'s header) — this module carries only the small slice
 * of `parse.ts` that `nextOccurrence` itself depends on: the Oslo wall-clock helpers and the
 * day-of-week table, copied verbatim rather than re-derived, so the recurrence math matches
 * the old system's bit for bit.
 *
 * Supported formats:
 *   "weekly:<dow>:<HH>:<MM>"   — e.g. "weekly:mon:11:30"
 *   "weekdays:<HH>:<MM>"       — Mon-Fri, e.g. "weekdays:09:00"
 *   "daily:<HH>:<MM>"          — every day, e.g. "daily:08:00"
 *
 * `from` is the Date the reminder just fired (the delivered row's due_at). Returns the next
 * occurrence strictly AFTER `from` — advancing by one calendar unit before searching, so a
 * fast-ticking loop can never re-fire the same minute twice.
 */

import { clockParts, slotKey } from "@lares/agent-kit/owner-clock";

/**
 * The HOME clock, and now only a default.
 *
 * ORB-193 parameterised these helpers by timezone: every one of Saga's slot schedules used to
 * compute its slot from this constant, and four of them carried their own copy of `osloSlotNow`,
 * so "08:00" meant 08:00 in Oslo whatever continent Bendik was standing on (the ORB-124/128/204
 * class: a job that fired mid-flight). The tz-taking helpers below are what Task 3 moves those
 * schedules onto; `osloParts`/`osloDate` stay as wrappers over them because the recurrence math
 * in this file is deliberately still on the home clock — a repeating reminder Bendik set as
 * "weekdays 09:00" means 09:00 at home, and re-basing it mid-trip would silently move every
 * standing reminder he owns.
 */
export const TZ = "Europe/Oslo";

export const DOW_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** { date: "YYYY-MM-DD", hour, minute } for `d`, read in `tz`'s wall-clock time. Delegates to the
 *  kit's `clockParts` so the fleet has ONE formatter path — the per-turn clock block, the
 *  proactivity gate's quiet hours and these slot helpers must not read two different clocks. */
export function partsIn(d: Date, tz: string): { date: string; hour: number; minute: number } {
  const { date, hour, minute } = clockParts(d, tz);
  return { date, hour, minute };
}

/** The date-string (YYYY-MM-DD) `d` falls on, read in `tz`. */
export function dateIn(d: Date, tz: string): string {
  return partsIn(d, tz).date;
}

/**
 * `"<date>T<hour>"` on minute 0 of `hour` in `tz`, else `null` — the exact shape the four
 * hand-copied `osloSlotNow` helpers return, so a schedule moving onto this keeps comparing slot
 * keys with its own history rather than starting a new numbering. One definition, in the kit
 * (`@lares/agent-kit/owner-clock`'s `slotKey`); this is the seam Saga's schedules call.
 */
export function slotIn(now: Date, tz: string, hour: number): string | null {
  return slotKey(now, tz, hour);
}

/**
 * 0=Sun … 6=Sat for `d`, read in `tz` — derived from `partsIn`'s own date string rather than from
 * a second `Intl` call with a `weekday` option, so the day-of-week and the slot hour can never
 * come off two different formatters (the ORB-124/128/204 class of bug). The date string is ALREADY
 * the local calendar date, so all that is left is "which weekday is 2026-09-08" — read back in UTC,
 * the one zone in which reading a bare date cannot shift it into the day before or after.
 */
export function dowIn(d: Date, tz: string): number {
  return new Date(`${partsIn(d, tz).date}T00:00:00Z`).getUTCDay();
}

/** { date: "YYYY-MM-DD", hour, minute } for `d`, read in Europe/Oslo wall-clock time. */
export function osloParts(d: Date): { date: string; hour: number; minute: number } {
  return partsIn(d, TZ);
}

/** Oslo date-string (YYYY-MM-DD) for a given Date. */
export function osloDate(d: Date): string {
  return dateIn(d, TZ);
}

/** 0=Sun,1=Mon,...,6=Sat — Oslo day-of-week for a Date. */
function osloDow(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return names.indexOf(fmt.format(d));
}

/** Add N calendar days to an Oslo date string, return the new YYYY-MM-DD. */
export function addOsloDays(dateStr: string, n: number): string {
  const [y, mo, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1, day + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Build a Date from an Oslo local "YYYY-MM-DD HH:MM" string. */
export function osloLocalToDate(localIso: string): Date {
  const [datePart, timePart] = localIso.split(" ");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  // Start with a rough UTC guess (assume UTC+1, i.e. CET), then refine once by checking
  // what Oslo actually says about that instant and correcting for the offset.
  const guess = Date.UTC(year, month - 1, day, hour - 1, minute);
  const parts = osloParts(new Date(guess));
  const localFromGuess = `${parts.date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  const target = `${datePart} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const diffMinutes = minuteDiff(localFromGuess, target);
  return new Date(guess - diffMinutes * 60_000);
}

function minuteDiff(a: string, b: string): number {
  const toMin = (s: string) => {
    const [date, time] = s.split(" ");
    const [y, mo, d] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    return Date.UTC(y, mo - 1, d, h, m) / 60_000;
  };
  return toMin(a) - toMin(b);
}

/** Next Oslo date string (>= `now`) landing on `targetDow`, always strictly after `now`'s
 *  clock time on that day (callers pre-advance `now` by one day, so "today" never matches). */
export function nextDowDate(now: Date, targetDow: number, targetHour: number, targetMinute: number): string {
  const todayStr = osloDate(now);
  const nowDow = osloDow(now);
  const parts = osloParts(now);

  let daysAhead = (targetDow - nowDow + 7) % 7;
  if (daysAhead === 0) {
    if (parts.hour > targetHour || (parts.hour === targetHour && parts.minute >= targetMinute)) {
      daysAhead = 7;
    }
  }
  return daysAhead === 0 ? todayStr : addOsloDays(todayStr, daysAhead);
}

/** Next weekday (Mon-Fri) at the given time, on or after `now`. */
export function nextWeekdayDate(now: Date, targetHour: number, targetMinute: number): string {
  const todayStr = osloDate(now);
  const nowDow = osloDow(now);
  const parts = osloParts(now);

  const isWeekday = nowDow >= 1 && nowDow <= 5;
  if (isWeekday) {
    if (parts.hour < targetHour || (parts.hour === targetHour && parts.minute < targetMinute)) {
      return todayStr;
    }
  }
  let daysAhead = 1;
  for (;;) {
    const candidateDow = (nowDow + daysAhead) % 7;
    if (candidateDow >= 1 && candidateDow <= 5) break;
    daysAhead++;
  }
  return addOsloDays(todayStr, daysAhead);
}

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Parse a "HH:MM" time token into [hour, minute]. Throws on malformed input — a bad
 *  recurrence string is a bug in whatever wrote the row, not a value to silently coerce. */
function parseHHMM(token: string): [number, number] {
  const parts = token.split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid HH:MM token: "${token}"`);
  }
  return [parts[0], parts[1]];
}

/**
 * Compute the next occurrence of `recurrence` strictly after `from`.
 *
 * Advances by one calendar unit (1 day / 1 weekday / 1 week) before searching, guaranteeing
 * the result lands strictly after `from` even if the loop ticks more than once a minute.
 */
export function nextOccurrence(recurrence: string, from: Date): Date {
  const parts = recurrence.split(":");

  if (parts[0] === "daily") {
    const [h, m] = parseHHMM(`${parts[1]}:${parts[2]}`);
    const nextDateStr = addOsloDays(osloDate(from), 1);
    return osloLocalToDate(`${nextDateStr} ${hhmm(h, m)}`);
  }

  if (parts[0] === "weekdays") {
    const [h, m] = parseHHMM(`${parts[1]}:${parts[2]}`);
    const fromPlusOneDate = addOsloDays(osloDate(from), 1);
    const fromPlusOne = osloLocalToDate(`${fromPlusOneDate} 00:00`);
    const dateStr = nextWeekdayDate(fromPlusOne, h, m);
    return osloLocalToDate(`${dateStr} ${hhmm(h, m)}`);
  }

  if (parts[0] === "weekly") {
    const dowStr = parts[1];
    const [h, m] = parseHHMM(`${parts[2]}:${parts[3]}`);
    const targetDow = DOW_MAP[dowStr];
    if (targetDow === undefined) {
      throw new Error(`Unknown day-of-week abbreviation: "${dowStr}"`);
    }
    const fromPlusOneDate = addOsloDays(osloDate(from), 1);
    const fromPlusOne = osloLocalToDate(`${fromPlusOneDate} 00:00`);
    const dateStr = nextDowDate(fromPlusOne, targetDow, h, m);
    return osloLocalToDate(`${dateStr} ${hhmm(h, m)}`);
  }

  throw new Error(`Unsupported recurrence format: "${recurrence}"`);
}
