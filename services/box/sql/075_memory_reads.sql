-- 075_memory_reads.sql — which remembered things an answer actually opened (ADR-0017 rule 6).
--
-- WHY NOT 073_memory_use. That table is the retirement CLOCK: its primary key is
-- (kind, ref, owner) and it upserts last_used/uses, so it holds exactly one row per remembered
-- thing for all time. It can say a fact has been used and when last; it can never say which
-- answer used it, because it keeps no session and no turn. Widening it would destroy the one
-- question it does answer. Two tables, two questions.
--
-- APPEND-ONLY, ONE ROW PER (session, turn, kind, ref). A repeat read inside one turn is
-- collapsed by the primary key rather than counted: "which memories did this answer use" is a
-- set, not a tally.
--
-- turn_id = '' MEANS THE SESSION BLOCK. The standing-facts core is built once per session
-- (ADR-0018 rule 9) and is in front of the model on every turn of that session, so it belongs
-- to all of them and to none in particular. A reader unions the turn's own rows with the
-- session's '' rows; see lib/memory-reads.ts.
--
-- WHAT IS DELIBERATELY NOT RECORDED: a search. vault_search and atlas_search return a ranked
-- list the model may ignore entirely, and calling a hit "a memory this answer used" would be a
-- claim nobody checked. Only a thing fetched by id or by path is recorded.
--
-- `ref` is text, not a foreign key: it holds a bigint id from standing_facts, a uuid from
-- dream_preferences (created at runtime by ensureDreamTables, not by a numbered migration), a
-- bigint id from agent_notes and a store-relative file path. A constraint here would fail on a
-- box that has never started the role container.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_reads (
  session_id text        NOT NULL,
  turn_id    text        NOT NULL,
  owner      text        NOT NULL,
  kind       text        NOT NULL,
  ref        text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, turn_id, kind, ref),
  CONSTRAINT memory_reads_kind_check
    CHECK (kind IN ('standing_fact', 'preference', 'vault_note', 'agent_note'))
);

-- The answer query: one turn's rows plus its session's block rows.
CREATE INDEX IF NOT EXISTS memory_reads_turn_idx ON memory_reads (session_id, turn_id, at DESC);
-- The prune (W5A-s6) and an erase (W5B-s6), both keyed on the person.
CREATE INDEX IF NOT EXISTS memory_reads_owner_age_idx ON memory_reads (owner, at);

COMMIT;
