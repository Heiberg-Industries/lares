-- Manual installation migration; never applied by keeper startup. Idempotent.
ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_status_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_status_check CHECK(status IN ('valid','invalid','retired'));
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS retired_folder text;
