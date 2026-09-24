/**
 * Read-only access to `dream_preferences` — the bi-temporal preference store `saga-dream` (a
 * SIBLING CONTAINER that keeps running through and after this wave's cutover, unaffected by it)
 * writes via its own nightly reflect→promote cycle. eve-saga only READS this table, for the
 * weekly learning summary (`agent/schedules/weekly-summary.ts`) — it never writes to it and
 * never migrates it: the table already exists in the SAME shared `lares_state` Postgres this
 * service already connects to via `getPool()` (`services/box/compose.yaml:263-265`'s own
 * comment confirms the wiring: "the weekly learning summary is now a scheduled brain-turn in
 * the saga service... this [saga-dream] service is sealed and keeps only the nightly
 * reflect→promote cycle").
 *
 * ORB-134 (Task 5): `lib/dream/store.ts` — ported separately, for the reflect→promote cycle
 * itself — runs this identical query as `makeDreamStore(db).activePreferences()`. Rather than
 * two implementations of the same SQL against the same table, this file is now a thin
 * re-export over that one, reshaped back to a standalone function taking `db: Pool` directly —
 * matching every sibling store in this package (`lib/obligations-store.ts`,
 * `lib/reminders-store.ts`, `lib/proposals-store.ts`) — so the existing callers
 * (`agent/schedules/weekly-summary.ts`, `tests/brief-prompts.test.ts`) don't need to change
 * call shape. `record`, `addPreference`, `supersede`, `ownerRecurrenceCount` and the observations table
 * belong to the reflect→promote cycle itself, which stays in `saga-dream` — not exposed here.
 */
import type { Pool } from "pg";

import { makeDreamStore, type PreferenceRow } from "./dream/store.js";

export type { PreferenceRow };

/** All currently active preferences (`valid_to IS NULL`), most-confident first. */
export async function activePreferences(db: Pool): Promise<PreferenceRow[]> {
  return makeDreamStore(db).activePreferences();
}
