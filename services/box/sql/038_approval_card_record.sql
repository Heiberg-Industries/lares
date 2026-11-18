-- 038_approval_card_record.sql: the card record learns where a card was posted.
--
-- WHAT THIS IS. `approval_asks` is the one record of every card an agent shows a person. The card
-- layer (one set of rules for every door) needs three more facts per card, and needs questions in
-- the same record:
--
--   door         the door the card was posted on (`slack`, `telegram`, `console`), or NULL for a
--                card written before this file.
--   card_address where the card sits on that platform, as JSON of named strings (Slack: the channel
--                and the message `ts`; Telegram: the chat and the message id). A tap names this, so
--                the layer can find the card it belongs to. NULL until the door has posted it.
--   put_to       the platform user id of the person the card was put to (who started the
--                conversation). A question is answered by that person; an approval by the owner.
--   shown_whole  true when the door showed everything the card is about, false when it had to cut
--                something, NULL when not known. NULL counts as "not whole" wherever it is checked.
--   kind         'approval' (every row before this file) or 'question'. A question has no tool call:
--                its call id is 'question:' plus the request id and its tool is 'question'.
--
-- A question that was answered settles as outcome 'answered', so that outcome is added to the list.
-- Rows written before this file keep NULL in the four new nullable columns and kind 'approval'.
--
-- Nothing here stores the words on a card: `payload_hash` stays a hash, and `card_address` holds
-- platform ids only.
--
-- SAFE TO RUN AGAIN. Only adds what is missing; no row is changed.

BEGIN;

ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS door text;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS card_address jsonb;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS put_to text;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS shown_whole boolean;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'approval';

ALTER TABLE approval_asks DROP CONSTRAINT IF EXISTS approval_asks_kind_check;
ALTER TABLE approval_asks ADD CONSTRAINT approval_asks_kind_check CHECK (kind IN ('approval', 'question'));

ALTER TABLE approval_asks DROP CONSTRAINT IF EXISTS approval_asks_outcome_check;
ALTER TABLE approval_asks ADD CONSTRAINT approval_asks_outcome_check CHECK (
  outcome IS NULL OR outcome = ANY (ARRAY['approved', 'cancelled', 'ignored', 'invalid', 'expired', 'payload-changed', 'answered'])
);

CREATE INDEX IF NOT EXISTS approval_asks_card_address_idx
    ON approval_asks (door, (card_address->>'channel'), (card_address->>'message'))
    WHERE card_address IS NOT NULL;

COMMIT;
