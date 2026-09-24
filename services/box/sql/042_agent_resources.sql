-- MANUAL ONLY. Apply in Task20, never during keeper startup.
-- Legacy stores are registered explicitly as 'legacy'; these are never deletable by keeper.
CREATE TABLE IF NOT EXISTS agent_resources (
 name text PRIMARY KEY,
 address inet NOT NULL UNIQUE,
 workflow_database text NOT NULL UNIQUE,
 ownership text NOT NULL CHECK (ownership IN ('owned','legacy')),
 ownership_token uuid NOT NULL,
 state text NOT NULL CHECK (state IN ('provisioning','ready','retired','deleting')),
 applied_definition jsonb,
 pending boolean NOT NULL DEFAULT true,
 pending_reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Install an EMPTY workflow template database using this release's world migrations manually.
-- Keeper clones that fixed template; it does not migrate runtime databases.
-- Import existing agents with their EXISTING workflow database and ownership='legacy'.
-- Never register shared Saga/lares_state as owned. Do not seed agents.ceiling here.
