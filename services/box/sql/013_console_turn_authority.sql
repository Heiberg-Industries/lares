-- Durable authority is independent of the prunable conversation projection.
BEGIN;
CREATE TABLE IF NOT EXISTS console_session_bindings (
  agent text NOT NULL,
  incarnation uuid NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  admission_nonce text NOT NULL CHECK (admission_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  place_id text NOT NULL CHECK (btrim(place_id) <> ''),
  member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience_revision integer NOT NULL DEFAULT 1 CHECK (audience_revision=1),
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (agent,incarnation,session_id),
  UNIQUE (agent,incarnation,admission_nonce)
);
CREATE INDEX IF NOT EXISTS console_session_bindings_member_idx ON console_session_bindings(member_id);
CREATE OR REPLACE FUNCTION guard_console_session_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR
     (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Conversation authority is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS console_session_binding_guard ON console_session_bindings;
CREATE TRIGGER console_session_binding_guard BEFORE UPDATE ON console_session_bindings FOR EACH ROW EXECUTE FUNCTION guard_console_session_binding();
COMMIT;
