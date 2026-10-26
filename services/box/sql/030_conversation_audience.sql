-- A conversation entry is reusable only when its private recipient was known at write time.
-- Legacy rows stay NULL and therefore cannot be treated as if their audience were known.
BEGIN;
ALTER TABLE conversation_entries
  ADD COLUMN IF NOT EXISTS audience_member_id text,
  ADD COLUMN IF NOT EXISTS audience_address text,
  ADD COLUMN IF NOT EXISTS audience_access_revision bigint;
ALTER TABLE conversation_entries
  ADD COLUMN IF NOT EXISTS approval_request_id text;

-- Web inbox continuity is eligible only for generated text with a pre-generation member/grant
-- and connected-account epoch fence that remained unchanged through publication. Existing rows
-- and prebuilt messages keep NULL and are never retrospectively admitted.
ALTER TABLE web_inbox
  ADD COLUMN IF NOT EXISTS continuity_member_id text,
  ADD COLUMN IF NOT EXISTS continuity_access_revision bigint,
  ADD COLUMN IF NOT EXISTS source_account_epochs jsonb;
CREATE INDEX IF NOT EXISTS web_inbox_continuity_idx
  ON web_inbox (owner, agent, continuity_member_id, continuity_access_revision, created_at DESC)
  WHERE source_account_epochs IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='conversation_entries'::regclass
       AND conname='conversation_entries_audience_pair_check'
       AND contype='c'
  ) THEN
    ALTER TABLE conversation_entries ADD CONSTRAINT conversation_entries_audience_pair_check
    CHECK ((audience_member_id IS NULL) = (audience_address IS NULL)
      AND (audience_member_id IS NULL) = (audience_access_revision IS NULL)
      AND (audience_access_revision IS NULL OR audience_access_revision > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversation_entries_audience_idx
  ON conversation_entries (agent, audience_member_id, audience_address, door, at DESC)
  WHERE audience_member_id IS NOT NULL;
COMMIT;
