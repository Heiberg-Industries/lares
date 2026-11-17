-- One writing profile per member, and room on the two existing voice tables to say whose a
-- mailbox's card and examples are and which connected account they came from.
--
-- Only adds. No existing row is changed or removed here: the new columns start empty, and the
-- one-time mapping of today's mailbox cards onto members and accounts is a separate command the
-- owner runs (`lares voices map`, services/box/bin/voice-mapping.ts), report first. Readers of the
-- two voice tables name their columns, so they see nothing new. Re-run safe; no triggers or functions.
BEGIN;

-- A member's common card. The per-language model choices are kept apart from style: they are the
-- model the voice was written for, not part of how the person writes. `guidance_note_path` points at
-- a Vault note with longer writing guidance, when there is one.
CREATE TABLE IF NOT EXISTS person_voice_profiles (
    owner_member_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE CHECK (owner_member_id <> ''),
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    core text NOT NULL DEFAULT '',
    notes_en text NOT NULL DEFAULT '',
    notes_no text NOT NULL DEFAULT '',
    avoid text[] NOT NULL DEFAULT '{}',
    model_en text,
    model_no text,
    guidance_note_path text CHECK (guidance_note_path IS NULL OR guidance_note_path <> ''),
    created_from text NOT NULL CHECK (created_from IN ('mapping', 'console')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A mailbox card (an Email variant) and its examples: whose they are, and from which account.
-- Removing the account keeps the card and examples and empties only the account column, so they are
-- held again rather than lost. Erasing the member removes them.
ALTER TABLE voice_profile ADD COLUMN IF NOT EXISTS owner_member_id text REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE voice_profile ADD COLUMN IF NOT EXISTS connected_account_id text;
ALTER TABLE voice_profile ADD COLUMN IF NOT EXISTS mapped_at timestamptz;
ALTER TABLE voice_exemplar ADD COLUMN IF NOT EXISTS owner_member_id text REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE voice_exemplar ADD COLUMN IF NOT EXISTS connected_account_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_profile'::regclass AND conname = 'voice_profile_account_owner_fk') THEN
    ALTER TABLE voice_profile ADD CONSTRAINT voice_profile_account_owner_fk
      FOREIGN KEY (connected_account_id, owner_member_id)
      REFERENCES connected_accounts(id, owner_member_id) ON DELETE SET NULL (connected_account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_profile'::regclass AND conname = 'voice_profile_account_needs_owner') THEN
    ALTER TABLE voice_profile ADD CONSTRAINT voice_profile_account_needs_owner
      CHECK (connected_account_id IS NULL OR owner_member_id IS NOT NULL);
  END IF;
  -- The shared `default` card is nobody's mailbox.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_profile'::regclass AND conname = 'voice_profile_default_has_no_account') THEN
    ALTER TABLE voice_profile ADD CONSTRAINT voice_profile_default_has_no_account
      CHECK (id <> 'default' OR connected_account_id IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_exemplar'::regclass AND conname = 'voice_exemplar_account_owner_fk') THEN
    ALTER TABLE voice_exemplar ADD CONSTRAINT voice_exemplar_account_owner_fk
      FOREIGN KEY (connected_account_id, owner_member_id)
      REFERENCES connected_accounts(id, owner_member_id) ON DELETE SET NULL (connected_account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_exemplar'::regclass AND conname = 'voice_exemplar_account_needs_owner') THEN
    ALTER TABLE voice_exemplar ADD CONSTRAINT voice_exemplar_account_needs_owner
      CHECK (connected_account_id IS NULL OR owner_member_id IS NOT NULL);
  END IF;
  -- A learn that was running when the mapping ran is marked interrupted; it is not restarted.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'voice_profile'::regclass AND conname = 'voice_profile_learn_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%interrupted%') THEN
    ALTER TABLE voice_profile DROP CONSTRAINT IF EXISTS voice_profile_learn_status_check;
    ALTER TABLE voice_profile ADD CONSTRAINT voice_profile_learn_status_check
      CHECK (learn_status IN ('idle', 'running', 'error', 'interrupted'));
  END IF;
END $$;

-- One Email variant per connected account.
CREATE UNIQUE INDEX IF NOT EXISTS voice_profile_one_card_per_account
    ON voice_profile (connected_account_id) WHERE connected_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_exemplar_owner_idx ON voice_exemplar (owner_member_id) WHERE owner_member_id IS NOT NULL;

COMMIT;
