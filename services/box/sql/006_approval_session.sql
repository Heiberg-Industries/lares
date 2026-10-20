-- 006_approval_session.sql: which conversation an approval card belongs to.
--
-- WHAT THIS IS. When the agent redrafts something, the older approval card for the same thing must
-- be withdrawn, or the owner could still approve the old version. To do that the ledger has to know
-- which conversation and which turn each unanswered card was raised in. A card waits across
-- restarts, so this is kept here and not in the agent's memory.
--
--   session_id     eve's id of the conversation the card was raised in.
--   turn_sequence  the turn within that conversation (counts up; a later turn has a larger number).
--   target_hash    SHA-256 of "what the card is about" (a thread, a recipient list, an event, a
--                  page), or NULL when the tool has no obvious target. A hash, never the value:
--                  the words and addresses a card showed are not stored here either.
--
-- A withdrawn card is settled as outcome 'cancelled' with answered_via 'revised'. Neither column has
-- a value list, so no constraint changes.
--
-- Rows written before this file have NULL in all three and are never withdrawn by a later card.
--
-- SAFE TO RUN AGAIN. Only adds what is missing; no row is changed.

BEGIN;

ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS session_id    TEXT;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS turn_sequence INTEGER;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS target_hash   TEXT;

CREATE INDEX IF NOT EXISTS approval_asks_open_by_session_idx
    ON approval_asks (session_id)
    WHERE outcome IS NULL AND session_id IS NOT NULL;

COMMIT;
