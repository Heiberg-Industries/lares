-- Exact-call authority extends the existing approval ledger; legacy cards remain evidence.
BEGIN;
ALTER TABLE approval_asks DROP CONSTRAINT IF EXISTS approval_asks_pkey;
ALTER TABLE approval_asks ALTER COLUMN request_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_asks_request_id_key ON approval_asks(request_id);
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS original_authority jsonb;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS acting_member_id text REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE approval_asks ADD COLUMN IF NOT EXISTS resolved_by_member_id text REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS approval_asks_member_idx ON approval_asks(acting_member_id);
CREATE OR REPLACE FUNCTION guard_exact_approval_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.original_authority IS NOT NULL AND (
     NEW.original_authority IS DISTINCT FROM OLD.original_authority OR
     NEW.acting_member_id IS DISTINCT FROM OLD.acting_member_id OR
     NEW.call_id IS DISTINCT FROM OLD.call_id OR NEW.agent IS DISTINCT FROM OLD.agent OR
     NEW.tool IS DISTINCT FROM OLD.tool OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
     NEW.asked_at IS DISTINCT FROM OLD.asked_at OR
     (OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id) OR
     (OLD.resolved_by_member_id IS NOT NULL AND NEW.resolved_by_member_id IS DISTINCT FROM OLD.resolved_by_member_id)) THEN
    RAISE EXCEPTION 'Exact approval authority is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS exact_approval_authority_guard ON approval_asks;
CREATE TRIGGER exact_approval_authority_guard BEFORE UPDATE ON approval_asks FOR EACH ROW EXECUTE FUNCTION guard_exact_approval_authority();
COMMIT;
