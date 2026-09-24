/**
 * Brief settings store — LAR-16-s1. Backs `sql/050_brief_settings.sql`'s one per-owner switch:
 * which language the morning/evening brief renders in. Shaped like the sibling settings stores
 * in this package (`readLadderEnabled` in `lib/deadlines-store.ts`, `readMarketsSettings` in
 * `lib/markets-settings-store.ts`): a plain function taking `db: Pool` first.
 *
 * The owner's amendment of 2026-09-18: the supported set is not fixed at "nb"/"en" — it is
 * English plus the four Nordic languages today, and a "global list" that will grow later. The
 * SQL column therefore only checks the two-letter FORMAT (`^[a-z]{2}$}`); this file is the single
 * place that knows which of those codes are actually supported.
 *
 * `readBriefLanguage` NEVER throws — the brief must still send even when the settings table is
 * missing, unreachable, or holds a code this build does not yet recognise. On any of those paths
 * it warns once and returns `"en"`, the same fail-open posture as `readLadderEnabled`.
 */
import type { Pool } from "pg";

export const BRIEF_LANGUAGES = ["en", "nb", "sv", "da", "fi"] as const;
export type BriefLanguage = (typeof BRIEF_LANGUAGES)[number];

export function isBriefLanguage(x: string): x is BriefLanguage {
  return (BRIEF_LANGUAGES as readonly string[]).includes(x);
}

/** `"en"` when no row exists, when the stored code is well-formed but not (yet) supported, or
 *  when the query throws. Never throws. */
export async function readBriefLanguage(db: Pool, owner: string): Promise<BriefLanguage> {
  let stored: string | undefined;
  try {
    const { rows } = await db.query<{ language: string }>(
      `SELECT language FROM brief_settings WHERE owner = $1`,
      [owner],
    );
    stored = rows[0]?.language;
  } catch (e) {
    console.warn(`brief-settings: could not read the brief language for ${owner} — defaulting to "en"`, e);
    return "en";
  }
  if (stored === undefined) {
    return "en";
  }
  if (isBriefLanguage(stored)) {
    return stored;
  }
  console.warn(`brief-settings: ${owner}'s stored brief language "${stored}" is not (yet) supported — defaulting to "en"`);
  return "en";
}
