-- Cached personal-source context must not outlive account authority or explicit reconnect.
BEGIN;
UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE private_surface_revision<2;
ALTER TABLE console_session_bindings DROP CONSTRAINT IF EXISTS console_binding_private_surface_capture;
ALTER TABLE console_session_bindings ADD CONSTRAINT console_binding_private_surface_capture CHECK (
  private_surface_revision=2 OR (private_surface_revision IN (0,1) AND revoked_at IS NOT NULL)
);
CREATE OR REPLACE FUNCTION invalidate_personal_account_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.generation,NEW.status) IS DISTINCT FROM (OLD.generation,OLD.status) THEN
    UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE member_id=OLD.owner_member_id AND private_surface_revision>0;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS personal_account_history_guard ON connected_accounts;
CREATE TRIGGER personal_account_history_guard AFTER UPDATE OF generation,status ON connected_accounts
  FOR EACH ROW EXECUTE FUNCTION invalidate_personal_account_history();
COMMIT;
