-- 005-standing-facts-validity.sql — the dated-facts field set (ADR-0017 rule 2).
--
-- WHAT IS DELIBERATELY NOT HERE: `valid_from` and `valid_to`. This table has had both since
-- sql/002-standing-facts.sql, under the names `stated_at` and `retired_at` — 002's own header
-- explains the second one ("Retirement never deletes… the superseded row is what explains why
-- she used to say train"), and lib/standing-facts.ts's forgetFact stamps it. Adding a second
-- pair would give one row two answers to "when did this stop being true", and a reader would
-- have to guess which one the writer meant. The mapping, stated once, here:
--
--     ADR-0017 rule 2 name   this table's column
--     valid_from             stated_at
--     valid_to               retired_at
--     recorded_at            recorded_at   (new below)
--     source                 source        (new below)
--     superseded_by          superseded_by (new below)
--     origin                 origin        (sql/004-standing-facts-origin.sql)
--
-- APPLIED BY HAND, like its three siblings. Every statement is safe to re-run.
--
-- NOTHING IS DELETED AND NO EXISTING ROW CHANGES MEANING. Only ADD COLUMN, and a backfill of
-- each new column from NULL to the value that row already implied. The two constraints at the
-- bottom are satisfied by every pre-existing row (all of them have superseded_by NULL), so this
-- file cannot fail on a table that already holds an owner's facts.
--
-- THE CODE MAY ARRIVE BEFORE THIS FILE DOES. An installation applies SQL by hand, possibly days
-- after the image that reads these columns is deployed. lib/standing-facts.ts therefore falls
-- back to the pre-005 column list on `42703 undefined_column` and warns once; the facts still
-- load. That fallback is what makes applying this file late a delay, not an outage.
BEGIN;

-- When the ROW was written, as opposed to when the fact became true. Backfilled to stated_at:
-- for every row this table currently holds the two instants are the same, because `remember`
-- has always inserted with COALESCE($5, now()) and no caller has ever passed $5 in production
-- (catalogue/remember.ts is the only writer, and it passes no statedAt).
--
-- The DEFAULT is set AFTER the backfill on purpose: an ADD COLUMN … DEFAULT now() would stamp
-- every pre-existing row with the moment the migration ran, which is a lie about when the fact
-- was learned. NULL-then-backfill is the only order that keeps the old rows honest.
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
UPDATE standing_facts SET recorded_at = stated_at WHERE recorded_at IS NULL;
ALTER TABLE standing_facts ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE standing_facts ALTER COLUMN recorded_at SET NOT NULL;

-- What wrote the row. Every existing row came from catalogue/remember.ts, which has been the
-- only writer since the table existed (sql/002-standing-facts.sql: "agent/tools/remember.ts is
-- the only writer"). A tool name, never a person and never a persona: this column is read by
-- the console's Memory list, where "where did this come from" must survive a rename.
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS source text;
UPDATE standing_facts SET source = 'remember' WHERE source IS NULL;
ALTER TABLE standing_facts ALTER COLUMN source SET DEFAULT 'remember';
ALTER TABLE standing_facts ALTER COLUMN source SET NOT NULL;

-- The row that replaced this one. NULL for every existing row: nothing has ever linked a
-- retirement to its replacement, which is the gap this column exists to close. Self-referencing
-- FK, so a link can never name a row that is not here; ON DELETE RESTRICT is implicit and
-- correct — this table deletes nothing, ever.
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS superseded_by bigint;
ALTER TABLE standing_facts DROP CONSTRAINT IF EXISTS standing_facts_superseded_by_fkey;
ALTER TABLE standing_facts
  ADD CONSTRAINT standing_facts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES standing_facts (id);

-- A row cannot replace itself, and a row that names a replacement must be closed. Both are
-- properties of the write path (W4A-s2), pinned here so a hand-applied fix cannot break them.
ALTER TABLE standing_facts DROP CONSTRAINT IF EXISTS standing_facts_supersede_shape_check;
ALTER TABLE standing_facts
  ADD CONSTRAINT standing_facts_supersede_shape_check
  CHECK (superseded_by IS NULL OR (superseded_by <> id AND retired_at IS NOT NULL));

COMMIT;
