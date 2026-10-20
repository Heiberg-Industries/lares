/**
 * Read-only access to `dream_preferences` — the bi-temporal preference store the nightly
 * reflect→promote cycle writes. chief-of-staff's schedules only READ this table here, for the
 * weekly learning summary (`agent/schedules/weekly-summary.ts`) — this file never writes to it and
 * never migrates it: the table already exists in the SAME shared `lares_state` Postgres this
 * service already connects to via `getPool()`.
 *
 * `lib/dream/store.ts`, which serves the reflect→promote cycle itself, runs this identical
 * query as `makeDreamStore(db).activePreferences()`. Rather than
 * two implementations of the same SQL against the same table, this file is a thin
 * re-export over that one, shaped as a standalone function taking `db: Pool` directly —
 * matching every sibling store in this package (`lib/obligations-store.ts`,
 * `lib/reminders-store.ts`, `lib/proposals-store.ts`) — so the callers
 * (`agent/schedules/weekly-summary.ts`, `tests/brief-prompts.test.ts`) keep one call shape.
 * `record`, `addPreference`, `supersede`, `ownerRecurrenceCount` and the observations table
 * belong to the reflect→promote cycle itself — not exposed here.
 */
import type { Pool } from "pg";

import { makeDreamStore, type PreferenceRow } from "./dream/store.js";

export type { PreferenceRow };

/** All currently active preferences (`valid_to IS NULL`), most-confident first. */
export async function activePreferences(db: Pool): Promise<PreferenceRow[]> {
  return makeDreamStore(db).activePreferences();
}
