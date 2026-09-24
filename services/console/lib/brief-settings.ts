/**
 * LAR-16-s3 — the read layer behind the brief language control on `/proactivity`.
 *
 * `BRIEF_LANGUAGES_MIRROR` MIRRORS, does not import, `services/chief-of-staff/lib/brief-settings.ts`'s
 * own `BRIEF_LANGUAGES` — the same "mirrored, not imported" rule `tests/engine-drift.test.ts` states
 * for this package's other engine constants (ADR-0014 rule 12): the console does not depend on
 * that service. `tests/engine-drift.test.ts` reads the agent side's source as TEXT and fails the
 * day the two lists disagree. This file adds a display name per code, which the agent side has no
 * use for.
 *
 * The owner's amendment of 2026-09-18: the supported set is English plus the four Nordic languages
 * today, and will grow — so this list, not a fixed nb/en pair, is the one the control offers and
 * the one `saveBriefLanguage` validates against.
 *
 * `readBriefLanguage` degrades like `getBackupStatus` in `lib/backup-status.ts`: a missing
 * `brief_settings` table (before `sql/050_brief_settings.sql` is hand-applied) or any other query
 * failure returns `unavailable: true` rather than taking the page down.
 */
import { pool } from "./db";

export { BRIEF_LANGUAGES_MIRROR, isBriefLanguageCode, type BriefLanguageCode } from "./brief-languages";
import { isBriefLanguageCode, type BriefLanguageCode } from "./brief-languages";

export interface BriefLanguageDTO {
  language: BriefLanguageCode;
  unavailable?: true;
}

/** `"en"` when no row exists or the stored code is not one this build offers. `unavailable: true`
 *  (still `"en"`) on any query failure, including a `brief_settings` table that does not exist yet. */
export async function readBriefLanguage(owner: string): Promise<BriefLanguageDTO> {
  try {
    const { rows } = await pool.query<{ language: string }>(
      `SELECT language FROM brief_settings WHERE owner = $1`,
      [owner],
    );
    const stored = rows[0]?.language;
    if (stored !== undefined && isBriefLanguageCode(stored)) return { language: stored };
    return { language: "en" };
  } catch {
    return { language: "en", unavailable: true };
  }
}
