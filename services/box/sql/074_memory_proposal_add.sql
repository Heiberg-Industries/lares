-- 074_memory_proposal_add.sql — the third action: an inference the owner is asked to keep
-- (ADR-0018 rule 4, "an `agent`-origin observation may be HELD for owner confirmation").
--
-- WHAT 072 ALREADY PROMISES, AND WHAT MUST SURVIVE THIS FILE UNCHANGED. 072's
-- memory_proposals_origin_check is CHECK (origin = 'owner'), and its header explains why: a bug
-- upstream must not be able to smuggle somebody else's words into something the owner is asked
-- to approve AS IF THEY WERE THEIR OWN. That guarantee is about superseding or retiring a row
-- the owner stated. It is NOT loosened here. The constraint becomes conditional on the action:
-- supersede and retire still admit 'owner' and nothing else; only the new 'add' admits 'agent',
-- and 'add' admits NOTHING ELSE — not 'owner' (an owner-origin observation is promoted by the
-- gate, it is never put to the owner), and never 'synced', 'third_party' or 'system', which
-- ADR-0018 rule 4 forbids from being promotion candidates at any confidence or recurrence.
--
-- WHY 'add' NEEDS ITS OWN DEDUP KEY. 072's memory_proposals_open_idx is
-- UNIQUE (existing_id) WHERE state IN ('pending','approved') — "one open proposal per standing
-- row". An add closes no row, so every open add would carry the same empty existing_id and the
-- second one would be rejected as a duplicate of the first. The index is SPLIT rather than
-- relaxed: supersede/retire keep theirs exactly, and add gets its own on `ref`, the
-- deterministic identity-<hash> string lib/dream/surface.ts already derives from the
-- observation's subject and text. That is dedup for free: the same inference re-derived on a
-- later night cannot queue twice, which is the same property the supersede index buys.
--
-- `kind` EXISTS BECAUSE dream_preferences.kind IS NOT NULL. Applying an approved add inserts a
-- dream_preferences row (lib/memory-proposal-apply.ts), and that table's kind column has no
-- default worth guessing. The observation's own kind is carried here rather than re-derived at
-- apply time from text the model wrote.
--
-- ALTERs memory_proposals, created by services/box/sql/072_memory_proposals.sql. 072 is
-- numbered >= 39, so the image probe's glob applies it before this file; no probe edit.
--
-- Hand-applied; idempotent; one transaction.
BEGIN;

ALTER TABLE memory_proposals ADD COLUMN IF NOT EXISTS ref  text NOT NULL DEFAULT '';
ALTER TABLE memory_proposals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT '';

ALTER TABLE memory_proposals DROP CONSTRAINT IF EXISTS memory_proposals_action_check;
ALTER TABLE memory_proposals
  ADD CONSTRAINT memory_proposals_action_check
  CHECK (action IN ('supersede', 'retire', 'add'));

ALTER TABLE memory_proposals DROP CONSTRAINT IF EXISTS memory_proposals_origin_check;
ALTER TABLE memory_proposals
  ADD CONSTRAINT memory_proposals_origin_check
  CHECK (
    (action IN ('supersede', 'retire') AND origin = 'owner') OR
    (action = 'add'                    AND origin = 'agent')
  );

ALTER TABLE memory_proposals DROP CONSTRAINT IF EXISTS memory_proposals_text_check;
ALTER TABLE memory_proposals
  ADD CONSTRAINT memory_proposals_text_check
  CHECK (
    (action = 'supersede' AND length(proposed_text) > 0) OR
    (action = 'retire'    AND proposed_text = '')        OR
    -- An add proposes words and closes nothing: it must name no existing row, quote no existing
    -- text, and carry both the dedup ref and the kind the apply pass needs.
    (action = 'add' AND length(proposed_text) > 0 AND existing_text = '' AND existing_id = ''
                   AND length(ref) > 0 AND length(kind) > 0)
  );

DROP INDEX IF EXISTS memory_proposals_open_idx;
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_open_idx
  ON memory_proposals (existing_id) WHERE state IN ('pending', 'approved') AND action <> 'add';
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_add_open_idx
  ON memory_proposals (ref) WHERE state IN ('pending', 'approved') AND action = 'add';

COMMIT;
