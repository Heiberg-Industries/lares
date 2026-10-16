-- 002_standing_facts.sql: the chief of staff's standing facts, on the one schema path.
--
-- WHAT THIS IS. The durable things an owner has SAID, in their own words, in their final shape
-- (the shape the four hand-applied files services/chief-of-staff/sql/002 to 005 used to build up to,
-- step by step; those files are gone). `agent/tools/remember.ts` is the only writer. A fresh
-- installation gets the table from `migrate` like every other table.
--
-- SAFE ON A DATABASE THAT ALREADY HAS THE TABLE. Every statement is "create if missing", so a
-- database that got the table from the old hand-applied files keeps it, and its rows, untouched.
-- That only holds for a table already in this final shape (all four old files applied).
--
-- COLUMN NAMES. ADR-0017 rule 2 calls the validity pair `valid_from` and `valid_to`; here they are
-- `stated_at` and `retired_at`, and there is deliberately no second pair. `origin` admits exactly one
-- value, so the table cannot hold a fact the agent inferred. Nothing is ever deleted: a retired row
-- is what explains why the agent used to say something else.

BEGIN;

CREATE TABLE IF NOT EXISTS standing_facts (
    id            BIGSERIAL PRIMARY KEY,
    -- The owner's own words, never the agent's paraphrase. Short by contract (the tool caps length).
    fact          TEXT NOT NULL,
    -- The tool's zod enum is the enforcement; no CHECK, so a new category is a code change only.
    category      TEXT NOT NULL,
    -- The eve turn the words were said in, so any row traces back to its conversation.
    source_turn   TEXT NOT NULL,
    -- The owner the fact belongs to.
    user_id       TEXT NOT NULL,
    -- When the fact became true (valid_from).
    stated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = still standing (valid_to).
    retired_at    TIMESTAMPTZ,
    -- When the ROW was written, as opposed to when the fact became true.
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- What wrote the row: a tool name, never a person or a persona.
    source        TEXT NOT NULL DEFAULT 'remember',
    origin        TEXT NOT NULL DEFAULT 'owner',
    -- The row that replaced this one. Nothing here is deleted, so the link can never dangle.
    superseded_by BIGINT,
    CONSTRAINT standing_facts_origin_check CHECK (origin = 'owner'),
    -- An unowned fact would be readable by nobody and erasable by no one.
    CONSTRAINT standing_facts_user_id_not_empty CHECK (user_id <> ''),
    CONSTRAINT standing_facts_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES standing_facts (id),
    -- A row cannot replace itself, and a row that names a replacement must be closed.
    CONSTRAINT standing_facts_supersede_shape_check
        CHECK (superseded_by IS NULL OR (superseded_by <> id AND retired_at IS NOT NULL))
);

-- The query that runs on every turn: one owner's active facts, newest first, capped.
-- (stated_at, id) DESC, not stated_at alone: a cap over a partial order drops an arbitrary half of a tie.
CREATE INDEX IF NOT EXISTS standing_facts_active_idx
    ON standing_facts (stated_at DESC, id DESC) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS standing_facts_owner_active_idx
    ON standing_facts (user_id, stated_at DESC, id DESC) WHERE retired_at IS NULL;

COMMIT;
