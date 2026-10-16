-- 003_outside_tool_seen.sql: what an outside tool's server said when its descriptions stopped matching.
--
-- WHAT THIS IS. `outside_tool_pins` (001_baseline.sql) keeps one fingerprint per agent and outside
-- tool: a hash of the tool descriptions the server sent the first time the agent connected. When a
-- later check finds different descriptions, the agent switches that connection off and opens a
-- repair. Until now it kept nothing of what it saw, so nobody could review the new descriptions or
-- accept exactly those. These columns hold it:
--   pin_tools   the descriptions the current fingerprint was taken from (NULL on rows recorded
--               before this file, until their next matching check fills it in);
--   seen_hash   the fingerprint of the different descriptions the last check saw (NULL = no mismatch);
--   seen_tools  those descriptions: each allowed tool's name, description and input schema, as the
--               server sent them (NULL when they were too long to keep);
--   seen_at     when they were seen.
-- The agent writes the seen_* columns on a mismatch and clears them on a match or a fresh record. It
-- never accepts them itself: only the owner's console action (`outside.accept_fingerprint` in the
-- keeper) moves seen_hash into pin_hash, and only when it is the hash the owner was shown.
--
-- SAFE TO RUN AGAIN. Only adds columns that are missing and a constraint that is missing; no row is
-- changed. The table holds hashes and the descriptions a server published, never an address, a key
-- or anything about a person.

BEGIN;

ALTER TABLE outside_tool_pins
    ADD COLUMN IF NOT EXISTS pin_tools  JSONB,
    ADD COLUMN IF NOT EXISTS seen_hash  TEXT,
    ADD COLUMN IF NOT EXISTS seen_tools JSONB,
    ADD COLUMN IF NOT EXISTS seen_at    TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'outside_tool_pins_seen_shape' AND conrelid = 'outside_tool_pins'::regclass
    ) THEN
        ALTER TABLE outside_tool_pins ADD CONSTRAINT outside_tool_pins_seen_shape CHECK (
            (seen_hash IS NULL OR length(seen_hash) = 64)
            AND (seen_tools IS NULL OR jsonb_typeof(seen_tools) = 'array')
            AND (pin_tools IS NULL OR jsonb_typeof(pin_tools) = 'array')
        );
    END IF;
END $$;

COMMIT;
