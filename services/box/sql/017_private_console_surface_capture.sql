-- A formerly broad private conversation must never become a bounded one by prompt refresh.
-- Preserve history, retire old captures, and refuse active creates from an older runtime.
BEGIN;
ALTER TABLE console_session_bindings ADD COLUMN IF NOT EXISTS private_surface_revision integer NOT NULL DEFAULT 0;
UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE private_surface_revision=0;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='console_session_bindings'::regclass AND conname='console_binding_private_surface_capture') THEN
    ALTER TABLE console_session_bindings ADD CONSTRAINT console_binding_private_surface_capture CHECK (
      private_surface_revision=1 OR (private_surface_revision=0 AND revoked_at IS NOT NULL)
    );
  END IF;
END $$;
-- guard_console_session_binding compares all columns except first revocation, including this one.
COMMIT;
