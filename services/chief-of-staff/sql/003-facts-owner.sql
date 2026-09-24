-- 003-facts-owner.sql — standing_facts gains an owner (multi-user substrate, Phase 2).
-- Spec Part 5 item 2: ORB-167 gated WHO MAY WRITE; the rows themselves were unscoped.
-- APPLIED BY HAND on the box before the eve-saga image carrying the code change starts.
-- Existing unscoped rows require an explicit reviewed ownership backfill.
-- This migration refuses to guess their author.
BEGIN;
ALTER TABLE standing_facts ADD COLUMN IF NOT EXISTS user_id text NOT NULL;
CREATE INDEX IF NOT EXISTS standing_facts_owner_active_idx
  ON standing_facts (user_id, stated_at DESC, id DESC) WHERE retired_at IS NULL;
COMMIT;
