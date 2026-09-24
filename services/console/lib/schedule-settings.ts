/**
 * LAR-17-s5 — the read layer behind the "When the agents speak" control on `/proactivity`.
 *
 * `sql/065_schedule_settings.sql` holds one row per `(owner, schedule)`: the whole-hour slot list
 * that schedule fires on. The mirror of the kit's defaults and validation lives in
 * `lib/schedule-hours.ts`, a database-free module `components/ScheduleHoursControl.tsx` (a client
 * component) can import directly — see that file's own header for why the split exists.
 *
 * `readScheduleHoursSettings` degrades like `readBriefLanguage` in `lib/brief-settings.ts`: a
 * missing `schedule_settings` table (an installation that has not hand-applied sql/065 yet) or any
 * other query failure returns `unavailable: true` with the engine defaults, rather than taking the
 * page down.
 */
import { pool } from "./db";

export {
  SCHEDULE_HOUR_DEFAULTS, SINGLE_SLOT, OWNER_FACING_SCHEDULES, isOwnerFacingSchedule, validateHours,
} from "./schedule-hours";
import { OWNER_FACING_SCHEDULES, SCHEDULE_HOUR_DEFAULTS, type OwnerFacingSchedule } from "./schedule-hours";
export type { ScheduleName, OwnerFacingSchedule, HoursValidation } from "./schedule-hours";

export interface ScheduleHoursRowDTO {
  schedule: OwnerFacingSchedule;
  label: string;
  /** The hours the engine will actually fire on — the stored row, or the engine default when none
   *  is stored. `sql/065`'s own CHECK already keeps a stored row well-formed, so no re-validation
   *  step is needed here the way `lib/proactivity.ts`'s ceilings and quiet hours need one. */
  hours: number[];
  /** True when no row is stored for this schedule — the page's "· default" marker. */
  isDefault: boolean;
}

export interface ScheduleHoursView {
  rows: ScheduleHoursRowDTO[];
  /** Set when `schedule_settings` could not be read at all (including a table that does not exist
   *  yet — sql/065 not hand-applied). Still carries the engine defaults, exactly like
   *  `BriefLanguageDTO`'s own `unavailable`. */
  unavailable?: true;
}

const defaultRows = (): ScheduleHoursRowDTO[] =>
  OWNER_FACING_SCHEDULES.map(({ schedule, label }) => ({
    schedule, label, hours: [...SCHEDULE_HOUR_DEFAULTS[schedule]!], isDefault: true,
  }));

/** Every owner-facing schedule's effective hours, in one round of reads. */
export async function readScheduleHoursSettings(owner: string): Promise<ScheduleHoursView> {
  try {
    const { rows } = await pool.query<{ schedule: string; hours: number[] }>(
      `SELECT schedule, hours FROM schedule_settings WHERE owner = $1`,
      [owner],
    );
    const stored = new Map(rows.map((r) => [r.schedule, r.hours]));
    return {
      rows: OWNER_FACING_SCHEDULES.map(({ schedule, label }) => {
        const row = stored.get(schedule);
        return {
          schedule, label,
          hours: row ?? [...SCHEDULE_HOUR_DEFAULTS[schedule]!],
          isDefault: row === undefined,
        };
      }),
    };
  } catch {
    return { rows: defaultRows(), unavailable: true };
  }
}
