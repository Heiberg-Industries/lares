-- 004-standing-facts-origin.sql — the origin model (docs/specs/2026-09-18-origin-model-design.md).
--
-- WHY A COLUMN THE TABLE'S OWN HEADER ARGUES AGAINST. sql/002-standing-facts.sql:21-22 says
-- "WHAT IS DELIBERATELY ABSENT: an 'inferred by' or 'confidence' column. There is no such row —
-- a fact the agent inferred does not belong here at all, and a column for it would invite one."
-- That rule is kept, not broken: the CHECK below admits exactly ONE value. The column exists so
-- a reader can filter on origin without knowing this table's history, and so the same query
-- shape works across standing_facts, the conversation record and the dream tables. It cannot
-- become the column 002 feared, because the constraint refuses every other class.
--
-- APPLIED BY HAND, like its siblings. Every statement is safe to re-run.
BEGIN;

ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS origin text;

-- Every pre-existing row is owner-origin by construction: catalogue/remember.ts has always
-- refused a turn with no allowlisted human present (humanTurnRefusal, remember.ts:70-74), so
-- nothing else has ever been able to insert here.
UPDATE standing_facts SET origin = 'owner' WHERE origin IS NULL;

ALTER TABLE standing_facts ALTER COLUMN origin SET DEFAULT 'owner';
ALTER TABLE standing_facts ALTER COLUMN origin SET NOT NULL;

ALTER TABLE standing_facts DROP CONSTRAINT IF EXISTS standing_facts_origin_check;
ALTER TABLE standing_facts ADD CONSTRAINT standing_facts_origin_check CHECK (origin = 'owner');

COMMIT;
