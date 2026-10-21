-- Transport/pricing support only. This does not open accounts or reconcile recovery.
BEGIN;
-- Drain authority and financial writers before DDL/FK locks. A policy INSERT may own
-- console locks before its users FK check; abort rather than wait in that cycle.
LOCK TABLE users IN EXCLUSIVE MODE;
LOCK TABLE console_session_bindings IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE budget_accounts,budget_gateway_bindings,budget_attempts IN ACCESS EXCLUSIVE MODE;
-- The existing full-row budget_immutable guard protects this new financial snapshot.
-- Nullable legacy bindings remain settleable through their existing trusted adapters.
ALTER TABLE budget_gateway_bindings ADD COLUMN IF NOT EXISTS pricing_profile jsonb;
CREATE TABLE IF NOT EXISTS budget_gateway_grants (
  attempt_id uuid PRIMARY KEY REFERENCES budget_attempts(id),
  grant_hash text NOT NULL CHECK(grant_hash ~ '^[a-f0-9]{64}$')
);
CREATE OR REPLACE FUNCTION budget_gateway_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gateway grant evidence is immutable';
END $$;
DROP TRIGGER IF EXISTS budget_gateway_grant_immutable ON budget_gateway_grants;
CREATE TRIGGER budget_gateway_grant_immutable BEFORE UPDATE OR DELETE ON budget_gateway_grants FOR EACH ROW EXECUTE FUNCTION budget_gateway_grant_immutable();
COMMIT;
