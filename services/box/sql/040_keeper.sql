-- Privileged keeper audit: pending intent is durable BEFORE execution (R23).
-- A pending row after interruption means uncertain outcome, never permission to replay.
CREATE TABLE IF NOT EXISTS keeper_audit (
 id bigserial PRIMARY KEY,
 operation_id uuid UNIQUE,
 action text NOT NULL,
 actor text NOT NULL,
 input jsonb NOT NULL DEFAULT '{}',
 outcome text NOT NULL CHECK (outcome IN ('pending', 'ok', 'refused', 'failed')),
 detail text,
 at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS keeper_audit_at_idx ON keeper_audit (at DESC);
CREATE INDEX IF NOT EXISTS keeper_audit_action_idx ON keeper_audit (action, at DESC);
CREATE TABLE IF NOT EXISTS settings (
 key text PRIMARY KEY, value jsonb NOT NULL, updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings_audit (
 id bigserial PRIMARY KEY, key text NOT NULL, old_value jsonb, new_value jsonb,
 changed_by text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION settings_audit_fn() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN RETURN NEW; END IF;
 INSERT INTO settings_audit (key, old_value, new_value, changed_by)
 VALUES (NEW.key, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END, NEW.value, NEW.updated_by);
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settings_audit_trg ON settings;
CREATE TRIGGER settings_audit_trg AFTER INSERT OR UPDATE ON settings
 FOR EACH ROW EXECUTE FUNCTION settings_audit_fn();
