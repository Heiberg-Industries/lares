-- Retained metadata dependencies only. This enables no filesystem access.
BEGIN;
-- Older runtimes require policy revision 1 when resuming. Retire it permanently and require
-- an explicit current revision on INSERT; the legacy default intentionally remains 1.
ALTER TABLE console_session_bindings DROP CONSTRAINT IF EXISTS console_session_bindings_policy_revision_check;
UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE policy_revision=1;
ALTER TABLE console_session_bindings DROP CONSTRAINT IF EXISTS console_binding_source_policy_version;
ALTER TABLE console_session_bindings ADD CONSTRAINT console_binding_source_policy_version
  CHECK(policy_revision=2 OR (policy_revision=1 AND revoked_at IS NOT NULL));
ALTER TABLE console_session_bindings ADD COLUMN IF NOT EXISTS source_history_guard_revision integer NOT NULL DEFAULT 0 CHECK(source_history_guard_revision IN (0,1));
CREATE UNIQUE INDEX IF NOT EXISTS console_binding_exact_source_tuple ON console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce);
CREATE TABLE IF NOT EXISTS console_vault_source_captures (
  agent text NOT NULL,
  incarnation uuid NOT NULL,
  session_id text NOT NULL,
  member_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admission_nonce text NOT NULL,
  area_id text NOT NULL REFERENCES vault_areas(id) ON DELETE RESTRICT,
  access_revision bigint NOT NULL CHECK(access_revision>0 AND access_revision<=9007199254740991),
  permission text NOT NULL DEFAULT 'use' CHECK(permission='use'),
  session_definition_hash text NOT NULL CHECK(session_definition_hash ~ '^[a-f0-9]{64}$'),
  original_valid_until timestamptz,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(agent,incarnation,session_id,member_id,admission_nonce,area_id),
  FOREIGN KEY(agent,incarnation,session_id,member_id,admission_nonce)
    REFERENCES console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS console_vault_source_area_idx ON console_vault_source_captures(area_id);
CREATE INDEX IF NOT EXISTS console_vault_source_member_idx ON console_vault_source_captures(member_id);
CREATE OR REPLACE FUNCTION guard_console_vault_source_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Conversation source history is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM console_session_bindings WHERE agent=NEW.agent AND incarnation=NEW.incarnation
      AND session_id=NEW.session_id AND member_id=NEW.member_id AND admission_nonce=NEW.admission_nonce
      AND source_history_guard_revision=1 AND policy_revision=2 AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Conversation source guard is unavailable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS console_vault_source_guard ON console_vault_source_captures;
CREATE TRIGGER console_vault_source_guard BEFORE INSERT OR UPDATE OR DELETE ON console_vault_source_captures FOR EACH ROW EXECUTE FUNCTION guard_console_vault_source_capture();
COMMIT;
