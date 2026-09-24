-- ORB-119 / voice-learn re-home — one exemplar corpus per mailbox.
--
-- The old learner (services/agent-runtime/bin/voice-learn.ts:73-82) resolved ALL Google
-- accounts, split its cap across them, and pooled the results into one corpus with no record
-- of origin. So every pre-existing row is a BLEND of owner@owner.example and owner@project.example
-- sent mail presented as a single voice — which is the defect this splits apart.
--
-- Those rows cannot be assigned to a mailbox after the fact: there is no origin column and a
-- Gmail message id does not carry its account. They are therefore retired rather than
-- guessed at — a wrong guess would ground one mailbox's drafts in the other's voice, which
-- is worse than having no examples (drafting degrades gracefully to rules-only). They are
-- kept, not deleted: recoverable if the re-learn disappoints.
--
-- The card (voice_profile) is deliberately NOT split — it holds the rules, which describe one
-- human; only the examples are audience-specific (Bendik, 2026-08-18).

ALTER TABLE voice_exemplar ADD COLUMN IF NOT EXISTS mailbox text NOT NULL DEFAULT 'legacy:blended';

-- The id is a Gmail message id, unique only WITHIN an account, so the mailbox belongs in the
-- key. Without this, the same id learned in two mailboxes would collide and one would
-- silently overwrite the other on upsert.
ALTER TABLE voice_exemplar DROP CONSTRAINT IF EXISTS voice_exemplar_pkey;
ALTER TABLE voice_exemplar ADD PRIMARY KEY (mailbox, id);

-- Retrieval always filters on both columns.
CREATE INDEX IF NOT EXISTS voice_exemplar_mailbox_included_idx ON voice_exemplar (mailbox, included);

-- Retire the blended corpus. Scoped to the legacy marker so re-running this migration can
-- never switch off a real per-mailbox corpus learned after it.
UPDATE voice_exemplar SET included = false WHERE mailbox = 'legacy:blended';
