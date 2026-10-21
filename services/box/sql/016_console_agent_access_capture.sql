-- Historical conversations retain their rows, but cannot infer agent adoption or access.
BEGIN;
ALTER TABLE console_session_bindings ADD COLUMN IF NOT EXISTS agent_access_revision bigint;
UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE agent_access_revision IS NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='console_session_bindings'::regclass AND conname='console_binding_access_capture') THEN
    ALTER TABLE console_session_bindings ADD CONSTRAINT console_binding_access_capture CHECK (
      (revoked_at IS NOT NULL OR agent_access_revision IS NOT NULL) AND
      (agent_access_revision IS NULL OR (agent_access_revision>0 AND agent_access_revision<=9007199254740991))
    );
  END IF;
END $$;
-- guard_console_session_binding already makes every field except first revocation immutable.
COMMIT;
