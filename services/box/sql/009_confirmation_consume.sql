-- Confirmation consume state-machine for exactly-once gated execution.
ALTER TABLE confirmations DROP CONSTRAINT IF EXISTS confirmations_status_ck;
ALTER TABLE confirmations ADD CONSTRAINT confirmations_status_ck
  CHECK (status IN ('pending','approved','rejected','expired','consuming','consumed'));
ALTER TABLE confirmations ADD COLUMN IF NOT EXISTS effect_result jsonb;
ALTER TABLE confirmations ADD COLUMN IF NOT EXISTS consumed_at   timestamptz;
