-- Metadata only: no filesystem adoption, mount paths, credentials or provider remotes.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS vault_access_revision_seq MAXVALUE 9007199254740991;
CREATE TABLE IF NOT EXISTS vault_backing_stores (
  id text PRIMARY KEY CHECK (btrim(id)<>''),
  organisation_id text NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('git','files')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS vault_areas (
  id text PRIMARY KEY CHECK (btrim(id)<>''),
  organisation_id text NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('private','shared','place','taste')),
  owner_member_id text REFERENCES users(id),
  owner_organisation_id text REFERENCES orgs(id),
  backing_store_id text NOT NULL REFERENCES vault_backing_stores(id),
  relative_path text NOT NULL CHECK (relative_path<>'' AND btrim(relative_path)=relative_path AND relative_path !~ '(^/|\\|//|(^|/)\.{1,2}(/|$)|/$)' AND relative_path !~ '[[:cntrl:]]'),
  revision bigint NOT NULL DEFAULT nextval('vault_access_revision_seq') CHECK (revision>0 AND revision<=9007199254740991),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(owner_member_id,owner_organisation_id)=1),
  CHECK (kind<>'private' OR owner_member_id IS NOT NULL)
);
-- One Vault per installation, hence one active logical taste home across organisations.
CREATE UNIQUE INDEX IF NOT EXISTS vault_one_active_taste ON vault_areas ((kind)) WHERE kind='taste' AND status='active';
-- Retirement does not prove that backing files were erased. Retained identities reserve
-- their paths until a future explicit storage-reconciliation flow can release them.
CREATE UNIQUE INDEX IF NOT EXISTS vault_reserved_path ON vault_areas(backing_store_id,relative_path);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM vault_areas a JOIN vault_areas b ON a.backing_store_id=b.backing_store_id AND a.id<b.id
    WHERE starts_with(a.relative_path,b.relative_path||'/') OR starts_with(b.relative_path,a.relative_path||'/')) THEN
    RAISE EXCEPTION 'Existing Vault area paths overlap; reconcile storage before continuing';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_vault_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE store vault_backing_stores; member users;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Vault identity is retained; retire instead'; END IF;
  PERFORM 1 FROM orgs WHERE id=NEW.organisation_id FOR UPDATE;
  IF TG_TABLE_NAME='vault_backing_stores' THEN
    IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status='retired') THEN
      RAISE EXCEPTION 'Vault backing identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['revision','status']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','status']) OR NEW.revision<=OLD.revision OR OLD.status='retired' THEN
      RAISE EXCEPTION 'Vault area identity is immutable and revision must advance';
    END IF;
  END IF;
  -- Retiring remains possible after a member leaves or backing retires.
  IF NEW.status='retired' AND TG_OP='UPDATE' THEN RETURN NEW; END IF;
  IF NEW.owner_member_id IS NOT NULL THEN
    SELECT * INTO member FROM users WHERE id=NEW.owner_member_id FOR SHARE;
    IF member.id IS NULL OR member.org_id IS DISTINCT FROM NEW.organisation_id OR member.status<>'active' THEN RAISE EXCEPTION 'Vault owner must be a current member of its organisation'; END IF;
  ELSIF NEW.owner_organisation_id<>NEW.organisation_id THEN RAISE EXCEPTION 'Vault owner organisation mismatch'; END IF;
  SELECT * INTO store FROM vault_backing_stores WHERE id=NEW.backing_store_id FOR UPDATE;
  IF store.id IS NULL OR store.organisation_id<>NEW.organisation_id OR store.status<>'active' THEN RAISE EXCEPTION 'Vault backing is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM vault_areas a WHERE a.id<>NEW.id AND a.backing_store_id=NEW.backing_store_id AND
    (a.relative_path=NEW.relative_path OR starts_with(a.relative_path,NEW.relative_path||'/') OR starts_with(NEW.relative_path,a.relative_path||'/'))) THEN
    RAISE EXCEPTION 'Vault area paths overlap';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vault_backing_guard ON vault_backing_stores;
CREATE TRIGGER vault_backing_guard BEFORE INSERT OR UPDATE OR DELETE ON vault_backing_stores FOR EACH ROW EXECUTE FUNCTION guard_vault_metadata();
DROP TRIGGER IF EXISTS vault_area_guard ON vault_areas;
CREATE TRIGGER vault_area_guard BEFORE INSERT OR UPDATE OR DELETE ON vault_areas FOR EACH ROW EXECUTE FUNCTION guard_vault_metadata();
CREATE OR REPLACE FUNCTION invalidate_member_vault_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- Explicit person erasure can delete membership without a removed-state transition.
    -- Surviving organisation grants must never revive a capture if that id is reused.
    UPDATE vault_areas SET revision=nextval('vault_access_revision_seq') WHERE status='active' AND organisation_id=OLD.org_id;
    RETURN OLD;
  END IF;
  IF (NEW.status,NEW.org_id,NEW.org_role) IS DISTINCT FROM (OLD.status,OLD.org_id,OLD.org_role) THEN
    UPDATE vault_areas SET revision=nextval('vault_access_revision_seq'),status=CASE WHEN owner_member_id=NEW.id AND (NEW.status<>'active' OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN 'retired' ELSE status END
      WHERE status='active' AND organisation_id IN (OLD.org_id,NEW.org_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_vault_access_guard ON users;
CREATE TRIGGER member_vault_access_guard AFTER UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION invalidate_member_vault_access();
CREATE OR REPLACE FUNCTION retire_vault_backing_areas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='retired' AND OLD.status='active' THEN
    UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE backing_store_id=NEW.id AND status='active';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vault_backing_retire ON vault_backing_stores;
CREATE TRIGGER vault_backing_retire AFTER UPDATE ON vault_backing_stores FOR EACH ROW EXECUTE FUNCTION retire_vault_backing_areas();
COMMIT;
