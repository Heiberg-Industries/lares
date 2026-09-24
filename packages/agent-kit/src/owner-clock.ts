/**
 * ORB-193 — which timezone the owner is standing in, right now. One answer, every agent.
 *
 * Every schedule in the fleet used to read `Europe/Oslo` off a constant, and four of Saga's copied
 * the same `osloSlotNow` helper. That has already cost real messages: ORB-124/128 and ORB-204 each
 * fired a job on a clock nobody was standing on (a 09:00 New York post while Bendik was in the
 * air). Quiet hours make it worse rather than better — a quiet window on the wrong clock is a gate
 * that opens at 3 a.m.
 *
 * Three sources, in a FIXED priority, and the order is the decision (spec 2026-09-03, Ruling 1):
 *
 *   1. **trip** — Marcel's `config.json`: a date window plus the destination's timezone. The
 *      strongest signal there is, because a human declared it in advance. Read from the file both
 *      agents already mount, NOT from Marcel's booking-derived arrival refinement (ORB-124): the
 *      two must give the same answer, and a shared file is the only way that holds.
 *   2. **slack-profile** — the timezone Slack reports for Bendik's own account, refreshed every 30
 *      minutes by `services/chief-of-staff/agent/schedules/owner-clock.ts`. Slack updates it from the
 *      device, so it catches the trip nobody filed. Counts only while it is FRESH (24 h): a signal
 *      with no age is not a signal, it is a memory of one.
 *   3. **home** — `OWNER_HOME_TZ`, default `Europe/Oslo`. The floor. Reached whenever the two
 *      above say nothing, which is most days.
 *
 * Calendar travel events are deliberately NOT a source in v1 (plan Ruling 2).
 *
 * TWO ABSOLUTE RULES, both learned the hard way:
 *
 * - **This never throws.** A clock failure that takes a schedule with it is the ORB-179 shape (the
 *   digest ran nowhere for ten days and everything looked healthy). An unreadable trip store, a
 *   dead database, a timezone string no `Intl` accepts — each degrades to the next source down,
 *   loudly in the log and silently to the caller.
 * - **A candidate timezone is validated before it is believed.** `Intl.DateTimeFormat` throws on an
 *   unknown zone, and this value reaches every slot computation in the service: one bad string in
 *   Marcel's config or a legacy Slack profile would otherwise stop every schedule at once.
 *
 * All wall-clock arithmetic reuses `./proactivity.ts`'s zone helpers (`ownerDay`, `wallClock`) —
 * one formatter path in the kit, not two, because "date and time off the same clock" is precisely
 * what the timezone bugs got wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

import { ownerDay, wallClock } from "./proactivity.js";

/** Anything with a `query` — a pool or a client, same as `HeartbeatDb`. */
export type OwnerClockDb = Pick<Pool, "query">;

/** The default home clock. Also the floor when a configured home tz is unusable. */
export const DEFAULT_HOME_TZ = "Europe/Oslo";

/** How long a Slack-profile observation counts for. Slack refreshes it from the device; a whole
 *  day of silence means the signal is stale, not that he is still there. */
export const SLACK_SIGNAL_MAX_AGE_HOURS = 24;

/** The source that won, and enough detail for a console row or a log line to say WHY. */
export interface OwnerClock {
  tz: string;
  source: "trip" | "slack-profile" | "home";
  detail: string;
}

/** A trip as this resolver needs it — the flattened slice of Marcel's `Trip`. */
export interface OwnerClockTrip {
  slug: string;
  name?: string;
  /** Inclusive ISO date. */
  start: string;
  /** Inclusive ISO date. */
  end: string;
  /** The destination's clock, e.g. `America/New_York`. */
  timezone: string;
}

export interface OwnerClockSources {
  trips: readonly OwnerClockTrip[];
  slackProfile?: { tz: string; observedAt: Date };
  homeTz: string;
  /** Defaults to {@link SLACK_SIGNAL_MAX_AGE_HOURS}. */
  slackMaxAgeHours?: number;
}

// ---------------------------------------------------------------------------------------------
// wall-clock parts
// ---------------------------------------------------------------------------------------------

const WEEKDAY = new Map<string, Intl.DateTimeFormat>();

function weekdayFormatter(tz: string): Intl.DateTimeFormat {
  let f = WEEKDAY.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" });
    WEEKDAY.set(tz, f);
  }
  return f;
}

/**
 * `now` as the owner reads it: the date, the hour and minute, and the weekday name.
 *
 * The single parts function for the fleet — `src/clock.ts`'s per-turn block and
 * `services/chief-of-staff/lib/recurrence.ts`'s slot math both come through here, so a turn's stated
 * date and a slot's firing hour can never come off two different clocks.
 *
 * Throws only if `tz` is not a zone `Intl` knows. Callers that take a tz from data
 * (`resolveOwnerClockFromSources`) validate it first; callers that hold a resolved
 * {@link OwnerClock} already have a validated one.
 */
export function clockParts(now: Date, tz: string): {
  date: string; hour: number; minute: number; hhmm: string; weekday: string;
} {
  const date = ownerDay(now, tz);
  const hhmm = wallClock(now, tz);
  const [hour, minute] = hhmm.split(":").map(Number);
  return { date, hour: hour ?? 0, minute: minute ?? 0, hhmm, weekday: weekdayFormatter(tz).format(now) };
}

/** The owner-clock calendar date (`YYYY-MM-DD`) of `now` in `tz`. */
export function dateIn(now: Date, tz: string): string {
  return ownerDay(now, tz);
}

/**
 * The fleet's slot key: `"<date>T<hour>"` on minute 0 of `hour` in `tz`, `null` otherwise.
 *
 * The shape is load-bearing rather than cosmetic — a slot-based schedule compares it against the
 * last slot it ran, so it is both the "is it time" test and the once-per-slot dedupe key (and,
 * from ORB-193 on, an `event`-class initiation's already-seen key). Copied by hand into four Saga
 * schedules as `osloSlotNow`; this is the one definition they now share.
 */
export function slotKey(now: Date, tz: string, hour: number): string | null {
  const { date, hour: h, minute } = clockParts(now, tz);
  return minute === 0 && h === hour ? `${date}T${h}` : null;
}

/** Is `tz` a zone this runtime knows? `Intl` throws on anything else, and that throw would reach
 *  every schedule at once, so no candidate is believed before it passes here. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// the resolver
// ---------------------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/**
 * Pure: given the sources, which clock is the owner on? Trip → Slack profile → home.
 *
 * A trip is active when `start <= <today in the trip's own timezone> <= end`, both ends inclusive.
 * The trip's OWN clock decides — not the home clock, which is what `services/chief-of-staff/lib/travel-store.ts`
 * deliberately uses for the brief's day boundary. The two differ on purpose: the brief must be
 * composed on one day boundary (Bendik's), while the question here is literally "what time is it
 * where he is", and on the far side of the Atlantic that answer flips six hours before Oslo's
 * midnight does.
 */
export function resolveOwnerClockFromSources(now: Date, opts: OwnerClockSources): OwnerClock {
  const home = isValidTimeZone(opts.homeTz) ? opts.homeTz : DEFAULT_HOME_TZ;
  if (!isValidTimeZone(opts.homeTz)) {
    console.warn(
      `owner-clock: home timezone ${JSON.stringify(opts.homeTz)} is not a zone this runtime knows — ` +
        `falling back to ${DEFAULT_HOME_TZ} (check OWNER_HOME_TZ)`,
    );
  }

  for (const t of opts.trips) {
    if (!isValidTimeZone(t.timezone)) {
      console.warn(
        `owner-clock: trip "${t.slug}" carries timezone ${JSON.stringify(t.timezone)}, which is not a ` +
          `zone this runtime knows — this trip cannot set the clock`,
      );
      continue;
    }
    const today = dateIn(now, t.timezone);
    if (t.start <= today && today <= t.end) {
      return {
        tz: t.timezone,
        source: "trip",
        detail: `trip ${t.slug}${t.name ? ` (${t.name})` : ""} ${t.start}→${t.end}`,
      };
    }
  }

  const signal = opts.slackProfile;
  if (signal !== undefined) {
    const ageHours = (now.getTime() - signal.observedAt.getTime()) / HOUR_MS;
    const maxAge = opts.slackMaxAgeHours ?? SLACK_SIGNAL_MAX_AGE_HOURS;
    if (!isValidTimeZone(signal.tz)) {
      console.warn(
        `owner-clock: Slack reported timezone ${JSON.stringify(signal.tz)}, which is not a zone this ` +
          `runtime knows — ignoring the signal`,
      );
    } else if (ageHours <= maxAge) {
      return {
        tz: signal.tz,
        source: "slack-profile",
        detail: `Slack profile, observed ${Math.max(0, Math.round(ageHours))}h ago`,
      };
    }
  }

  return { tz: home, source: "home", detail: `home timezone — no trip covers today${signal ? " and the Slack signal is stale" : ""}` };
}

// ---------------------------------------------------------------------------------------------
// the two sources that touch the world
// ---------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The trips in Marcel's `<dir>/config.json`.
 *
 * Mirrors, not imports, his `MarcelConfig` shape — separate services, separate images (the same
 * reasoning `services/chief-of-staff/lib/travel-store.ts` sets out at length, and its contract test is
 * what keeps the mirror honest). Per-entry validation: one malformed trip must not hide the five
 * good ones beside it. Every failure is no trips plus a log line — on most days there IS no trip,
 * so emptiness cannot be an error here.
 */
export function loadOwnerClockTrips(dir: string | undefined): OwnerClockTrip[] {
  if (dir === undefined || dir.trim() === "") return [];
  const file = join(dir, "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is worth one line, not a stack: an agent may simply not mount the trip store.
    if (code === "ENOENT") console.warn(`owner-clock: no trip store at ${file} — trips cannot set the clock`);
    else console.error(`owner-clock: could not read ${file}`, err);
    return [];
  }
  const raw = isRecord(parsed) ? parsed.trips : undefined;
  if (!Array.isArray(raw)) {
    console.error(`owner-clock: ${file} has no trips list — Marcel's schema may have changed`);
    return [];
  }
  const out: OwnerClockTrip[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { slug, name, start, end, timezone } = entry;
    if (typeof slug !== "string" || slug === "") continue;
    if (typeof start !== "string" || !ISO_DATE.test(start)) continue;
    if (typeof end !== "string" || !ISO_DATE.test(end)) continue;
    if (typeof timezone !== "string" || timezone === "") continue;
    out.push({ slug, start, end, timezone, ...(typeof name === "string" ? { name } : {}) });
  }
  return out;
}

/** The Slack-profile signal row for an owner, or `undefined` when there is none. Never throws:
 *  the caller's next source down is the answer. */
export async function readSlackProfileSignal(
  db: OwnerClockDb,
  owner: string,
): Promise<{ tz: string; observedAt: Date } | undefined> {
  try {
    const { rows } = await db.query<{ tz: string; observed_at: Date }>(
      `SELECT tz, observed_at FROM owner_clock_signals WHERE owner = $1 AND source = 'slack-profile'`,
      [owner],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { tz: row.tz, observedAt: new Date(row.observed_at) };
  } catch (err) {
    console.error(
      "owner-clock: could not read owner_clock_signals — falling through to the home timezone " +
        "(a trip, if any, still wins)",
      err,
    );
    return undefined;
  }
}

/**
 * Upsert the Slack-profile signal. ONE row per (owner, source): the question is "where is he
 * now", so a history of observations would be a different table and a different feature.
 *
 * Throws on a database failure — deliberately, unlike every read here. Its only caller is the
 * refresh schedule, which logs and stamps its pass anyway (the signal ages out on its own); a
 * write that silently did nothing would leave the clock quietly wrong instead.
 */
export async function recordSlackProfileSignal(db: OwnerClockDb, owner: string, tz: string): Promise<void> {
  await db.query(
    `INSERT INTO owner_clock_signals (owner, source, tz, observed_at)
     VALUES ($1, 'slack-profile', $2, now())
     ON CONFLICT (owner, source) DO UPDATE SET tz = EXCLUDED.tz, observed_at = now()`,
    [owner, tz],
  );
}

export interface ResolveOwnerClockOptions {
  now: Date;
  /** Marcel's data root as this process sees it (`TRAVEL_PATH` for Saga, `MARCEL_DATA_ROOT` for
   *  Marcel). Omitted → trips are simply not a source here. */
  tripsDir?: string;
  /** Omitted → the Slack-profile signal is not a source here. */
  db?: OwnerClockDb;
  owner: string;
  homeTz: string;
  slackMaxAgeHours?: number;
}

/**
 * The clock, resolved from the live sources. Never throws — every failure degrades one source down
 * and says so in the log, ending at the home timezone.
 */
export async function resolveOwnerClock(opts: ResolveOwnerClockOptions): Promise<OwnerClock> {
  const trips = loadOwnerClockTrips(opts.tripsDir);
  const slackProfile = opts.db ? await readSlackProfileSignal(opts.db, opts.owner) : undefined;
  return resolveOwnerClockFromSources(opts.now, {
    trips,
    ...(slackProfile ? { slackProfile } : {}),
    homeTz: opts.homeTz,
    ...(opts.slackMaxAgeHours === undefined ? {} : { slackMaxAgeHours: opts.slackMaxAgeHours }),
  });
}
