/**
 * LAR-17-s1 — "when do the agents speak" as a setting, not a code constant.
 *
 * Today every owner-facing schedule reads its hour(s) from a literal or an env var, one file at a
 * time (`services/chief-of-staff/agent/schedules/*.ts`). This module is the foundation the later
 * slices (LAR-17-s2..s4) point those reads at: one table, `schedule_settings` (sql/065), keyed
 * `(owner, schedule)`, and one reader. Nothing reads this table yet — wiring the schedules to it is
 * later work.
 *
 * `SCHEDULE_HOUR_DEFAULTS` is the single place an engine default lives, and every value here is
 * exactly what the code fires on today, so an installation with no rows in `schedule_settings`
 * behaves identically to before this table existed:
 *   - `morning-brief` : 8  — `agent/schedules/morning-brief.ts`'s `MORNING_HOUR`.
 *   - `evening-brief` : 20 — `agent/schedules/evening-brief.ts`'s `EVENING_HOUR`.
 *   - `digest`        : 9, 17 — `lib/digest/schedule.ts`'s `dueScheduledSlot` default parameter.
 *   - `crm-routing`   : 9, 13, 17 — `agent/schedules/crm-routing.ts`'s `DEFAULT_ROUTE_HOURS`.
 *   - `weekly-summary`: 9  — `agent/schedules/weekly-summary.ts`'s `weeklyHour()` default.
 *   - `voice-learn`   : 4  — `agent/schedules/voice-learn.ts`'s `LEARN_HOUR`.
 *   - `dream`         : 3  — `agent/schedules/dream.ts`'s `DEFAULT_HOUR` (env `DREAM_HOUR`).
 *
 * Keys are role-neutral (`morning-brief`, not a persona-prefixed key like the heartbeat rows'
 * `<agent>/<schedule>`) — this engine package holds no persona names, and a settings key is
 * per-installation data, not a heartbeat row shared across services.
 *
 * `readScheduleHours` never throws for an unreachable database or a corrupted row — a settings
 * read must never be the reason a brief does not go out — but an unknown SCHEDULE NAME throws at
 * call time, because that is a programmer error (a typo in the caller), not a settings problem.
 */
import type { Pool } from "pg";

export type ScheduleSettingsDb = Pick<Pool, "query">;

/** The engine default hours for every known schedule, on the owner's clock. The single place an
 *  engine default lives — sql/065 seeds no rows, so an installation with no row here gets exactly
 *  this. Verified against the code that fires today; see the module header for file:line. */
export const SCHEDULE_HOUR_DEFAULTS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  "morning-brief": [8],
  "evening-brief": [20],
  digest: [9, 17],
  "crm-routing": [9, 13, 17],
  "weekly-summary": [9],
  "voice-learn": [4],
  dream: [3],
});

export type ScheduleName = keyof typeof SCHEDULE_HOUR_DEFAULTS;

/** Every schedule that fires at exactly one hour a day — everything except `digest` and
 *  `crm-routing`, which fire several passes a day. */
export const SINGLE_SLOT: ReadonlySet<string> = new Set(
  Object.keys(SCHEDULE_HOUR_DEFAULTS).filter((s) => s !== "digest" && s !== "crm-routing"),
);

export type HoursValidation = { ok: true } | { ok: false; message: string };

/** Whole hours, 0-23, unique, sorted ascending, and exactly one for a single-slot schedule. Mirrors
 *  the CHECK constraints on `schedule_settings.hours` (cardinality and range) plus the shape rule
 *  this module owns (single-slot cardinality), so a caller gets the same plain-sentence refusal the
 *  database would otherwise give as an opaque constraint violation. */
export function validateHours(schedule: string, hours: number[]): HoursValidation {
  if (!(schedule in SCHEDULE_HOUR_DEFAULTS)) {
    return { ok: false, message: `${JSON.stringify(schedule)} is not a known schedule.` };
  }
  if (!Array.isArray(hours) || hours.length === 0) {
    return { ok: false, message: "At least one hour is required." };
  }
  if (hours.length > 6) {
    return { ok: false, message: "At most 6 hours a day are allowed." };
  }
  if (SINGLE_SLOT.has(schedule) && hours.length !== 1) {
    return { ok: false, message: `${schedule} takes exactly one hour.` };
  }
  for (const h of hours) {
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return { ok: false, message: `${JSON.stringify(h)} is not a whole hour between 0 and 23.` };
    }
  }
  if (new Set(hours).size !== hours.length) {
    return { ok: false, message: "Hours must not repeat." };
  }
  for (let i = 1; i < hours.length; i++) {
    if (hours[i]! <= hours[i - 1]!) {
      return { ok: false, message: "Hours must be sorted, lowest to highest." };
    }
  }
  return { ok: true };
}

interface ScheduleSettingsRow {
  hours: number[];
}

/**
 * The hours `schedule` fires on for `owner`, on the owner's clock.
 *
 * With no row, an invalid stored value, or a query that throws, this returns the engine default
 * and warns once — it never throws for any of those, because a settings read must never be the
 * reason a schedule's tick does not run. An unknown `schedule` name throws immediately: that is a
 * caller passing a name this module does not know, not a settings problem.
 */
export async function readScheduleHours(
  db: ScheduleSettingsDb, owner: string, schedule: string,
): Promise<number[]> {
  const fallback = SCHEDULE_HOUR_DEFAULTS[schedule as ScheduleName];
  if (!fallback) {
    throw new Error(`schedule-settings: ${JSON.stringify(schedule)} is not a known schedule`);
  }
  try {
    const { rows } = await db.query<ScheduleSettingsRow>(
      `SELECT hours FROM schedule_settings WHERE owner = $1 AND schedule = $2`,
      [owner, schedule],
    );
    const row = rows[0];
    if (!row) return [...fallback];
    const check = validateHours(schedule, row.hours);
    if (!check.ok) {
      console.warn(
        `schedule-settings: stored hours for ${owner}/${schedule} are invalid (${check.message}) — ` +
        `using the default ${JSON.stringify(fallback)}`,
      );
      return [...fallback];
    }
    return row.hours;
  } catch (e) {
    console.warn(
      `schedule-settings: could not read hours for ${owner}/${schedule} — using the default ${JSON.stringify(fallback)}`,
      e,
    );
    return [...fallback];
  }
}
