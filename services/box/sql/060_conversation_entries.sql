-- 060_conversation_entries.sql — ADR-0020's one conversation record.
--
-- WHAT THIS REPLACES: the dated markdown files under the vault's `_meta/conversations/`
-- (lib/conversation-log.ts). It does NOT replace `agent_conversations` (sql/043), which answers
-- a different question — which sessions exist right now and can the operator reset one — and has
-- never held transcript content (ADR-0020 rule 6).
--
-- APPEND-ONLY BY CONTRACT, not by constraint. There is no unique key on
-- (agent, session_id, turn_id): a correction is a new row, and the eviction path in
-- agent/hooks/turn-capture.ts can legitimately write the same exchange twice (once unfinished,
-- once terminal) — which is information, not a duplicate to swallow. Readers order by
-- recorded_at and take the last.
--
-- person_key is the canonical user id, never a channel address. It is what an
-- erase-a-person routine (LAR-21) keys on. It is NOT a foreign key: an entry must outlive
-- alias churn in whatever identity registry sits above it, the same reasoning
-- sql/003-facts-owner.sql already applies to standing_facts.
--
-- Self-contained: it creates its own table and ALTERs nothing older, so the image probe can
-- apply it on its own. Hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS conversation_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text        NOT NULL,
  session_id   text        NOT NULL,
  turn_id      text        NOT NULL,
  door         text        NOT NULL,
  person_key   text        NOT NULL,
  -- The scheduled lane ("morning-brief"), or NULL when a human spoke. Kept as its own column
  -- rather than inferred from origin: the dream cycle's exclusion rule is about WHO STARTED the
  -- turn, and origin is about where the CONTENT came from. A human turn that quoted an email is
  -- lane NULL, origin third_party — two different facts.
  lane         text,
  origin       text        NOT NULL,
  input        text        NOT NULL,
  reply        text        NOT NULL,
  proposals    text[]      NOT NULL DEFAULT '{}',
  -- When the exchange happened. turn-capture.ts stamps an unfinished exchange with its start,
  -- not with flush time, and the dream cycle reads by this column.
  at           timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_entries_origin_check
    CHECK (origin IN ('owner', 'agent', 'synced', 'third_party', 'system'))
);

-- The dream cycle's query: one agent's entries after a cursor, oldest first.
CREATE INDEX IF NOT EXISTS conversation_entries_since_idx
  ON conversation_entries (agent, at ASC);

-- Export and erase, per person.
CREATE INDEX IF NOT EXISTS conversation_entries_person_idx
  ON conversation_entries (person_key, at DESC);

-- The nightly prune's range scan.
CREATE INDEX IF NOT EXISTS conversation_entries_age_idx
  ON conversation_entries (at);

COMMIT;
