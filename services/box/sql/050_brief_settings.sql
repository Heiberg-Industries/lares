-- 050_brief_settings.sql — LAR-16-s1. The one per-owner switch Saga's brief reads to choose its
-- language, styled like `deadline_settings` in sql/036. `language` is a two-letter code with a
-- FORMAT check only, not an enumerated list: the owner's amendment of 2026-09-18 says the
-- supported set (English plus the four Nordic languages today) is a "global list" that will grow,
-- and adding a language later must never need a migration. `lib/brief-settings.ts` is the single
-- place that knows which codes are actually supported; a well-formed but unsupported code here
-- (e.g. a future 'de') degrades to English there rather than failing this constraint.
--
-- No row is seeded. This table is self-contained: it creates its own table and depends on no
-- older one, so the image probe (which applies 039 and up to a hand-built database) can apply it
-- on its own. Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS brief_settings (
  owner       text PRIMARY KEY,
  language    text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}$'),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
