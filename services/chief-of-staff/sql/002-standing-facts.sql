-- eve-saga: standing_facts — the durable things Bendik has SAID, in his own words (ORB-167).
--
-- WHICH DATABASE: `lares_state`, the box's shared state DB that `DATABASE_URL` points at and
-- `getPool()` (@lares/agent-kit/db) connects to — the same database `reminders`,
-- `obligation_threads` and `voice_profile` already live in. NOT the `workflow`/`workflow_drizzle`
-- schema of sql/001-eve-workflow.sql: that file is eve's own durable-session store, applied to
-- whatever `WORKFLOW_POSTGRES_URL`/`DATABASE_URL` the world package resolves. These are two
-- different concerns that happen to share a server; putting a domain table in eve's schema would
-- make it eve's to migrate.
--
-- APPLIED BY HAND. The agent box has no auto-migrate (project_agent_box_no_auto_migrate) — this
-- file is applied once, before the eve-saga container that reads it starts. Every statement is
-- safe to re-run.
--
-- WHY THIS TABLE EXISTS. On 2026-08-25 Bendik corrected Saga five times in one morning — the
-- train not the car, a venue-less intro call is remote, a hotel reservation is where he sleeps.
-- Every correction died with the chat. `fact` holds HIS words, verbatim, never Saga's paraphrase
-- of them: the compose contract's "never assert what isn't grounded" applies to memory too, and a
-- summarised fact is an assertion nobody can check. `agent/tools/remember.ts` is the only writer.
--
-- WHAT IS DELIBERATELY ABSENT: an "inferred by" or "confidence" column. There is no such row —
-- a fact Saga inferred does not belong here at all, and a column for it would invite one.

CREATE TABLE IF NOT EXISTS standing_facts (
    id          BIGSERIAL PRIMARY KEY,
    -- Bendik's own words. Short by contract (the tool caps length): this rides on every turn.
    fact        TEXT NOT NULL,
    -- travel | schedule | preference | people | places — the tool's zod enum is the enforcement;
    -- no CHECK constraint here, so adding a category is a code change, not a hand-applied one.
    category    TEXT NOT NULL,
    -- The eve turn the words were said in, so any row can be traced back to the conversation.
    source_turn TEXT NOT NULL,
    stated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = still standing. Retirement never deletes: "I've switched to driving" supersedes the
    -- train fact, and the superseded row is what explains why she used to say train.
    retired_at  TIMESTAMPTZ
);

-- The one query that runs on every single turn: active facts, newest first, capped.
-- (stated_at, id) DESC, not stated_at alone — a cap over a partial order silently drops an
-- arbitrary half of any tie, and a hand-seeded batch inserted in one statement shares a now().
CREATE INDEX IF NOT EXISTS standing_facts_active_idx
    ON standing_facts (stated_at DESC, id DESC)
    WHERE retired_at IS NULL;
