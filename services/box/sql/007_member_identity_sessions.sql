-- Additive member admission storage. No sign-in routes consume this migration yet.
BEGIN;
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS automation_mode text NOT NULL DEFAULT 'draft-and-ask';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE org_id IS NULL) THEN
    RAISE EXCEPTION 'Member migration refused: assign each existing user an explicit organisation; never infer or merge identities';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE primary_email IS NOT NULL GROUP BY lower(btrim(primary_email)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Member migration refused: duplicate emails require explicit identity reconciliation; no rows were merged';
  END IF;
  IF EXISTS (SELECT 1 FROM users u WHERE NOT EXISTS (SELECT 1 FROM users o WHERE o.org_id=u.org_id AND o.org_role='owner' AND o.status='active')) THEN
    RAISE EXCEPTION 'Member migration refused: each populated organisation needs an explicitly designated active owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_member_status_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_member_status_check CHECK (status IN ('invited','active','removed'));
    ALTER TABLE users ADD CONSTRAINT users_automation_mode_check CHECK (automation_mode IN ('draft-and-ask','expanded'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_member_email_unique ON users (lower(btrim(primary_email))) WHERE primary_email IS NOT NULL;
CREATE TABLE IF NOT EXISTS member_invitations (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS member_provider_identities (
  member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL CHECK (btrim(issuer) <> ''),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  tenant_id text NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject, tenant_id)
);
CREATE TABLE IF NOT EXISTS member_sessions (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_invitations_member_idx ON member_invitations(member_id);
CREATE INDEX IF NOT EXISTS member_provider_identities_member_idx ON member_provider_identities(member_id);
CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON member_sessions(member_id);
-- Lock the organisation before checking its last owner, including direct SQL writes.
CREATE OR REPLACE FUNCTION guard_member_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM orgs WHERE id=OLD.org_id FOR UPDATE;
  IF OLD.status='active' AND OLD.org_role='owner' AND
     (TG_OP='DELETE' OR NEW.status <> 'active' OR NEW.org_role <> 'owner' OR NEW.org_id <> OLD.org_id) AND
     NOT EXISTS (SELECT 1 FROM users WHERE org_id=OLD.org_id AND id<>OLD.id AND status='active' AND org_role='owner') THEN
    RAISE EXCEPTION 'Cannot remove or demote the last active owner; designate another active owner first';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.status <> 'active' THEN
    UPDATE member_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE member_id=OLD.id;
  END IF;
  IF NEW.status='removed' THEN
    UPDATE member_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE member_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_member_owner_guard ON users;
CREATE TRIGGER users_member_owner_guard BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION guard_member_owner();
COMMIT;
