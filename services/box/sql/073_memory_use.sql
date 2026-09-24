-- 073_memory_use.sql — when a remembered thing was last actually used (ADR-0018 rule 8).
--
-- WHAT THIS IS NOT. It is not retirement. ADR-0018 rule 8 wants active -> stale -> archived on a
-- usage clock, and nothing in this installation has ever recorded a use, so there is no history
-- to age anything against: a retirement job shipped today would archive everything on its first
-- run or nothing ever, depending on which way its default fell. This file starts the clock. The
-- transitions are a later wave, and they get to read months of real rows rather than a guess.
--
-- ONE ROW PER REMEMBERED THING, upserted — not an append-only log. A log of every injection
-- would grow by forty rows per session per door and answer exactly the same question.
--
-- `ref` is text, not a foreign key: it holds a bigint id from standing_facts and a uuid from
-- dream_preferences, and dream_preferences is created at runtime by ensureDreamTables
-- (services/chief-of-staff/lib/dream/store.ts), not by a numbered migration, so a constraint
-- here would fail on a box that has never started the role container.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_use (
  kind       text        NOT NULL,
  ref        text        NOT NULL,
  owner      text        NOT NULL,
  first_used timestamptz NOT NULL DEFAULT now(),
  last_used  timestamptz NOT NULL DEFAULT now(),
  uses       integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, ref, owner),
  CONSTRAINT memory_use_kind_check CHECK (kind IN ('standing_fact', 'preference'))
);

CREATE INDEX IF NOT EXISTS memory_use_stale_idx ON memory_use (owner, last_used);

COMMIT;
