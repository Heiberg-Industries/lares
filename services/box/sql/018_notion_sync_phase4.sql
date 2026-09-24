-- ORB-39 / Phase 4 (T3b) — a proposal can now be a CREATE, not only an edit.
--
-- Until now every notion_sync_proposals row meant the same thing: "Notion changed a
-- page whose vault file already exists; may I write the new body into it?". Phase 4
-- needs the other shape — a Notion row (a Meetings transcript, T4) or a Notion-born
-- page (T6) that has NO vault file yet and wants one created. Both must reach Bendik
-- through the SAME queue and the SAME 👍 (spec §18.4/§20: one approval path,
-- resolveProposal), so they are a KIND of proposal rather than a second table with a
-- second gate.
--
-- WHY A DEFAULT AND NOT A BACKFILL: every row that exists today, and every INSERT
-- written before this migration, means 'update'. `DEFAULT 'update'` makes both correct
-- without touching a single existing row or caller — which is what lets the apply
-- engine's update path stay byte-identical in behaviour.
--
-- The partial unique index `notion_sync_proposals_open` (016) is deliberately NOT
-- widened to include `kind`. It says "at most one OPEN proposal per vault_path", and
-- that rule gets STRONGER, not weaker, with creates in the table: an open create and an
-- open update for the same path would be two live claims on one file, and whichever
-- applied second would either overwrite the other's work or be refused as stale. One
-- open claim per path, whatever its kind, is exactly right.
--
-- Applied BY HAND on the agent box: there is no auto-migrate there. Idempotent, so a
-- re-run is safe.

BEGIN;

ALTER TABLE notion_sync_proposals
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'update';

-- Drop-then-add rather than a bare ADD (the house idiom, 009/010): ADD CONSTRAINT has
-- no IF NOT EXISTS, so this is what makes a re-run safe.
ALTER TABLE notion_sync_proposals DROP CONSTRAINT IF EXISTS notion_sync_proposals_kind_ck;
ALTER TABLE notion_sync_proposals ADD CONSTRAINT notion_sync_proposals_kind_ck
  CHECK (kind IN ('update','create'));

COMMIT;
