-- MANUAL ONLY after 039–044. Storage ownership and runtime authority are independent.
-- Existing owned resources keep authority; legacy resources default to no authority.
ALTER TABLE agent_resources ADD COLUMN runtime_control_token uuid;
ALTER TABLE agent_resources ADD CONSTRAINT runtime_control_current_incarnation
 CHECK (runtime_control_token IS NULL OR runtime_control_token = ownership_token);
UPDATE agent_resources SET runtime_control_token=ownership_token WHERE ownership='owned';
-- New resources explicitly set this token. Legacy adoption is an operator-reviewed UPDATE
-- matching exact name/incarnation/address/workflow_database AND ready state, asserting one
-- affected row and setting pending=true. No keeper action performs this adoption.
-- Never change ownership or add an owned database comment when adopting runtime control.
