-- Inactive durable invocation suppression. No gateway admission is enabled here.
BEGIN;
-- Drain member writes and erasure (which locks users FOR UPDATE) before owning console
-- locks: their existing retirement triggers touch budgets before revoking console access.
LOCK TABLE users IN EXCLUSIVE MODE;
-- Runtime authority is locked before budgets. Preserve that order during the cutover.
-- A policy INSERT may already own console locks before its users FK check. Do not
-- wait while holding the users gate: abort the whole transaction and retry after it commits.
LOCK TABLE console_session_bindings IN EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='budget_attempts' AND column_name='invocation_hash') THEN
    ALTER TABLE budget_attempts ADD COLUMN invocation_hash text CHECK(invocation_hash ~ '^[a-f0-9]{64}$') UNIQUE;
    -- Legacy rows have no trusted step index. Revoke affected members' old sessions once,
    -- without inventing hashes or erasing admitted/unknown/settled financial evidence.
    UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE member_id IN(SELECT DISTINCT live_member_id FROM budget_attempts WHERE live_member_id IS NOT NULL);
    UPDATE budget_attempts SET state='retired' WHERE state='prepared';
  END IF;
END $$;
-- An insert-only guard permits legacy NULL liabilities to settle and be redacted.
-- Keep this separate from SQL 011's functions, which are recreated on ordered reapply.
CREATE OR REPLACE FUNCTION budget_invocation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invocation_hash IS NULL THEN RAISE EXCEPTION 'Budget invocation is required'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_invocation_insert_guard ON budget_attempts;
CREATE TRIGGER budget_invocation_insert_guard BEFORE INSERT ON budget_attempts FOR EACH ROW EXECUTE FUNCTION budget_invocation_insert_guard();
COMMIT;
