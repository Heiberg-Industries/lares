-- Which model-provider key pays for an agent's calls. The key itself is never stored here:
-- it lives as a root-only file in the keeper-owned secrets directory, named by `revision`.
-- The gateway's admission reads agent/revision/state to choose it; no secret column exists.
BEGIN;
CREATE TABLE IF NOT EXISTS agent_provider_keys (
    agent text PRIMARY KEY REFERENCES agent_definitions(name) ON DELETE CASCADE,
    revision uuid NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN ('candidate', 'active')),
    set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- A role label, never a person: who put the key there.
    set_by text NOT NULL CHECK (set_by IN ('host', 'owner')),
    tested_at timestamptz,
    test_outcome text CHECK (test_outcome IN ('accepted', 'rejected', 'unreachable'))
);
COMMIT;
