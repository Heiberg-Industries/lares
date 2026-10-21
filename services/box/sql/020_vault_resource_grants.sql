-- Extend the existing grant registry, retaining agent foreign-key deletion semantics.
BEGIN;
LOCK TABLE resource_grants IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_resource_kind_check' AND contype='c' AND pg_get_constraintdef(oid) IN ('CHECK ((resource_kind = ''agent''::text))','CHECK ((resource_kind = ANY (ARRAY[''agent''::text, ''vault-area''::text])))')) THEN
    RAISE EXCEPTION 'Unexpected resource kind constraint; review schema before extending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname IN ('resource_grants_resource_id_fkey','resource_grants_agent_target_fk')) THEN
    RAISE EXCEPTION 'Missing agent resource foreign key';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_resource_id_fkey' AND (confrelid<>'agent_access'::regclass OR pg_get_constraintdef(oid)<>'FOREIGN KEY (resource_id) REFERENCES agent_access(agent_name) ON DELETE CASCADE')) THEN
    RAISE EXCEPTION 'Unexpected agent resource foreign key';
  END IF;
END $$;
ALTER TABLE resource_grants ADD COLUMN IF NOT EXISTS agent_resource_id text GENERATED ALWAYS AS (CASE WHEN resource_kind='agent' THEN resource_id END) STORED;
ALTER TABLE resource_grants ADD COLUMN IF NOT EXISTS vault_area_id text GENERATED ALWAYS AS (CASE WHEN resource_kind='vault-area' THEN resource_id END) STORED;
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='resource_grants'::regclass AND attname IN ('agent_resource_id','vault_area_id') AND attgenerated='s')<>2 THEN RAISE EXCEPTION 'Unexpected resource target columns'; END IF;
  IF (SELECT btrim(regexp_replace(pg_get_expr(ad.adbin,ad.adrelid),'[[:space:]]+',' ','g')) FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid=ad.adrelid AND a.attnum=ad.adnum WHERE a.attrelid='resource_grants'::regclass AND a.attname='agent_resource_id') IS DISTINCT FROM 'CASE WHEN (resource_kind = ''agent''::text) THEN resource_id ELSE NULL::text END' OR
     (SELECT btrim(regexp_replace(pg_get_expr(ad.adbin,ad.adrelid),'[[:space:]]+',' ','g')) FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid=ad.adrelid AND a.attnum=ad.adnum WHERE a.attrelid='resource_grants'::regclass AND a.attname='vault_area_id') IS DISTINCT FROM 'CASE WHEN (resource_kind = ''vault-area''::text) THEN resource_id ELSE NULL::text END' THEN
    RAISE EXCEPTION 'Unexpected generated resource target expression';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_agent_target_fk' AND pg_get_constraintdef(oid) NOT IN ('FOREIGN KEY (agent_resource_id) REFERENCES agent_access(agent_name) ON DELETE CASCADE','FOREIGN KEY (agent_resource_id) REFERENCES agent_access(agent_name) ON DELETE CASCADE NOT VALID')) OR
     EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_vault_target_fk' AND pg_get_constraintdef(oid) NOT IN ('FOREIGN KEY (vault_area_id) REFERENCES vault_areas(id)','FOREIGN KEY (vault_area_id) REFERENCES vault_areas(id) NOT VALID')) THEN
    RAISE EXCEPTION 'Unexpected resource target foreign key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_agent_target_fk') THEN
    ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_agent_target_fk FOREIGN KEY(agent_resource_id) REFERENCES agent_access(agent_name) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='resource_grants'::regclass AND conname='resource_grants_vault_target_fk') THEN
    ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_vault_target_fk FOREIGN KEY(vault_area_id) REFERENCES vault_areas(id) NOT VALID;
  END IF;
END $$;
ALTER TABLE resource_grants VALIDATE CONSTRAINT resource_grants_agent_target_fk;
ALTER TABLE resource_grants VALIDATE CONSTRAINT resource_grants_vault_target_fk;
ALTER TABLE resource_grants DROP CONSTRAINT IF EXISTS resource_grants_resource_id_fkey;
ALTER TABLE resource_grants DROP CONSTRAINT resource_grants_resource_kind_check;
ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_resource_kind_check CHECK (resource_kind IN ('agent','vault-area'));
-- BEFORE UPDATE sees derived NEW columns before PostgreSQL computes them. They are
-- nonwritable; compare only source columns. SQL014 reapply uses this same definition.
CREATE OR REPLACE FUNCTION immutable_resource_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['revoked_at','agent_resource_id','vault_area_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','agent_resource_id','vault_area_id']) OR
     (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Resource grant is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_vault_resource_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE area vault_areas; actor users; recipient users;
BEGIN
  IF NEW.resource_kind<>'vault-area' THEN RETURN NEW; END IF;
  SELECT * INTO area FROM vault_areas WHERE id=NEW.resource_id;
  IF area.id IS NULL THEN RAISE EXCEPTION 'Vault resource unavailable'; END IF;
  PERFORM 1 FROM orgs WHERE id=area.organisation_id FOR UPDATE;
  SELECT * INTO actor FROM users WHERE id=NEW.grantor_member_id FOR SHARE;
  IF actor.id IS NULL OR actor.status<>'active' OR actor.org_id IS DISTINCT FROM area.organisation_id OR
    (area.owner_member_id IS NOT NULL AND actor.id<>area.owner_member_id) OR
    (area.owner_organisation_id IS NOT NULL AND actor.org_role<>'owner') THEN RAISE EXCEPTION 'Vault grantor unavailable'; END IF;
  IF NEW.principal_member_id IS NOT NULL THEN
    SELECT * INTO recipient FROM users WHERE id=NEW.principal_member_id FOR SHARE;
    IF recipient.id IS NULL OR recipient.status<>'active' OR recipient.org_id IS DISTINCT FROM area.organisation_id THEN RAISE EXCEPTION 'Vault grantee unavailable'; END IF;
  ELSIF NEW.principal_organisation_id<>area.organisation_id THEN RAISE EXCEPTION 'Vault grantee organisation mismatch'; END IF;
  SELECT * INTO area FROM vault_areas WHERE id=NEW.resource_id FOR UPDATE;
  IF area.status<>'active' OR area.kind='private' OR NEW.issued_access_revision<>area.revision THEN RAISE EXCEPTION 'Vault grant unavailable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vault_resource_grant_guard ON resource_grants;
CREATE TRIGGER vault_resource_grant_guard BEFORE INSERT ON resource_grants FOR EACH ROW EXECUTE FUNCTION validate_vault_resource_grant();
COMMIT;
