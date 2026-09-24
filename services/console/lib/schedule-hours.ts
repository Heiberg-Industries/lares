/**
 * LAR-17-s5 — the console's mirror of `packages/agent-kit/src/schedule-settings.ts`'s
 * `SCHEDULE_HOUR_DEFAULTS`, `SINGLE_SLOT` and `validateHours`.
 *
 * MIRRORED, NOT IMPORTED (ADR-0014 rule 12) — the console deliberately does not depend on
 * `@lares/agent-kit` (`app/actions/meeting-series.ts` states the same rule for agent-runtime, and
 * `tests/engine-drift.test.ts`'s own header states it for this package). That test reads the
 * kit's source as TEXT and fails the day this drifts from it.
 *
 * DATABASE-FREE ON PURPOSE. `components/ScheduleHoursControl.tsx` is a CLIENT component: every
 * value it imports lands in the browser bundle, and a lib file that reaches `pg` through `./db`
 * breaks `next build` ("Can't resolve 'fs' / 'net' / 'tls'") in a way neither vitest nor tsc can
 * see — the exact trap `lib/brief-languages.ts`'s own header names for the brief-language control.
 * `lib/schedule-settings.ts` is the server-only module that reads `schedule_settings` and
 * re-exports everything here for its own callers.
 */

/** The engine default hours for every schedule the kit knows, on the owner's clock — a byte-for-
 *  byte copy of the kit's own constant. `dream` and `voice-learn` are internal night jobs with no
 *  owner-facing reason to move (LAR-17-s5's plan, decision 3): they stay in this mirror so the
 *  drift test can still catch the kit adding an eighth schedule, but `OWNER_FACING_SCHEDULES`
 *  below is what the console actually offers a control for. */
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
 *  `crm-routing`, which fire several passes a day. Mirrors the kit's own derivation. */
export const SINGLE_SLOT: ReadonlySet<string> = new Set(
  Object.keys(SCHEDULE_HOUR_DEFAULTS).filter((s) => s !== "digest" && s !== "crm-routing"),
);

/** The five schedules this page offers a control for. `dream` and `voice-learn` are refused by
 *  `saveScheduleHours` even though the mirror above knows them — the plan's own ruling (decision
 *  3): they are internal night jobs, not something the owner has a reason to move. Display names
 *  are this side's own, the same as `BRIEF_LANGUAGES_MIRROR`'s. */
export const OWNER_FACING_SCHEDULES = [
  { schedule: "morning-brief", label: "Morning brief" },
  { schedule: "evening-brief", label: "Evening brief" },
  { schedule: "digest", label: "Digest" },
  { schedule: "crm-routing", label: "CRM routing" },
  { schedule: "weekly-summary", label: "Weekly summary" },
] as const;

export type OwnerFacingSchedule = (typeof OWNER_FACING_SCHEDULES)[number]["schedule"];

export function isOwnerFacingSchedule(x: string): x is OwnerFacingSchedule {
  return OWNER_FACING_SCHEDULES.some((s) => s.schedule === x);
}

export type HoursValidation = { ok: true } | { ok: false; message: string };

/**
 * Whole hours, 0-23, unique, sorted ascending, and exactly one for a single-slot schedule — a
 * byte-for-byte mirror of the kit's own `validateHours` (`packages/agent-kit/src/schedule-settings.ts`),
 * so a caller here gets the same plain-sentence refusal the engine would otherwise give.
 */
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
