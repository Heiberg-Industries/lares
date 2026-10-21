-- Agent ownership is member data, separate from runtime incarnation/control tokens.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS resource_access_revision_seq MAXVALUE 9007199254740991;
CREATE TABLE IF NOT EXISTS agent_access (
  agent_name text PRIMARY KEY REFERENCES agent_definitions(name) ON DELETE CASCADE,
  owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT nextval('resource_access_revision_seq') CHECK (revision>0 AND revision<=9007199254740991)
);
CREATE TABLE IF NOT EXISTS resource_grants (
  id uuid PRIMARY KEY,
  resource_kind text NOT NULL CHECK (resource_kind='agent'),
  resource_id text NOT NULL REFERENCES agent_access(agent_name) ON DELETE CASCADE,
  principal_member_id text REFERENCES users(id) ON DELETE CASCADE,
  principal_organisation_id text REFERENCES orgs(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('use','edit')),
  grantor_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_access_revision bigint NOT NULL CHECK (issued_access_revision>0 AND issued_access_revision<=9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz CHECK (expires_at IS NULL OR expires_at>created_at),
  revoked_at timestamptz,
  CHECK (num_nonnulls(principal_member_id,principal_organisation_id)=1),
  CHECK (principal_organisation_id IS NULL OR permission='use')
);
CREATE INDEX IF NOT EXISTS resource_grants_resource_idx ON resource_grants(resource_id,issued_access_revision);
CREATE OR REPLACE FUNCTION agent_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.agent_name<>OLD.agent_name OR NEW.owner_member_id<>OLD.owner_member_id OR NEW.organisation_id<>OLD.organisation_id OR NEW.revision<=OLD.revision THEN
      RAISE EXCEPTION 'Agent ownership is immutable and access revision must advance';
    END IF;
  END IF;
  UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE agent=OLD.agent_name;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_access_changed_guard ON agent_access;
CREATE TRIGGER agent_access_changed_guard BEFORE UPDATE OR DELETE ON agent_access FOR EACH ROW EXECUTE FUNCTION agent_access_changed();
CREATE OR REPLACE FUNCTION immutable_resource_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['revoked_at','agent_resource_id','vault_area_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','agent_resource_id','vault_area_id']) OR
     (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Resource grant is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_resource_grant_guard ON resource_grants;
CREATE TRIGGER immutable_resource_grant_guard BEFORE UPDATE ON resource_grants FOR EACH ROW EXECUTE FUNCTION immutable_resource_grant();
-- Membership changes invalidate captures even if a member later rejoins or regains a role.
CREATE OR REPLACE FUNCTION invalidate_member_agent_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status,NEW.org_id,NEW.org_role) IS DISTINCT FROM (OLD.status,OLD.org_id,OLD.org_role) THEN
    UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE organisation_id IN (OLD.org_id,NEW.org_id);
    IF NEW.status<>'active' OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      UPDATE resource_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE principal_member_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_agent_access_guard ON users;
CREATE TRIGGER member_agent_access_guard AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION invalidate_member_agent_access();
-- Direct policy row locks protect current decisions; policy writes invalidate captures.
CREATE OR REPLACE FUNCTION invalidate_member_policy_agent_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_id text;
BEGIN
  IF TG_OP='DELETE' THEN member_id=OLD.user_id; ELSE member_id=NEW.user_id; END IF;
  UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE owner_member_id=member_id;
  IF TG_OP='UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE owner_member_id=OLD.user_id;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_policy_agent_access_guard ON org_member_policy;
CREATE TRIGGER member_policy_agent_access_guard BEFORE INSERT OR UPDATE OR DELETE ON org_member_policy FOR EACH ROW EXECUTE FUNCTION invalidate_member_policy_agent_access();
-- A definition cannot change away and back while leaving an old capture current.
CREATE OR REPLACE FUNCTION invalidate_definition_agent_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.hash,NEW.status) IS DISTINCT FROM (OLD.hash,OLD.status) THEN
    UPDATE agent_access SET revision=nextval('resource_access_revision_seq') WHERE agent_name=NEW.name;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS definition_agent_access_guard ON agent_definitions;
CREATE TRIGGER definition_agent_access_guard AFTER UPDATE OF hash,status ON agent_definitions FOR EACH ROW EXECUTE FUNCTION invalidate_definition_agent_access();
COMMIT;
