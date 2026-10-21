-- Inactive admission ledger. No gateway/runtime hook is enabled by this migration.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_type WHERE typname='budget_money') THEN
    CREATE DOMAIN budget_money AS numeric CHECK(VALUE >= 0 AND VALUE < 1000000000000000000 AND scale(VALUE)<=18);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS budget_accounts (
  id uuid PRIMARY KEY,
  installation_id text NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('installation','member')),
  installation_account_id uuid NOT NULL,
  live_member_id text REFERENCES users(id) ON DELETE SET NULL,
  organisation_id text,
  canonical_suppression_hash text CHECK(canonical_suppression_hash ~ '^[a-f0-9]{64}$'),
  provider_suppression_hashes text[] NOT NULL DEFAULT '{}' CHECK(cardinality(provider_suppression_hashes)<=64 AND array_position(provider_suppression_hashes,NULL) IS NULL),
  policy_generation bigint NOT NULL DEFAULT 0 CHECK(policy_generation>=0),
  state text NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','frozen','retired')),
  reason text NOT NULL DEFAULT 'unreconciled' CHECK(reason IN ('unreconciled','approved','policy_changed','member_removed','member_erased','receipt_conflict','over_reservation','recovery_mismatch')),
  active_window_id uuid,
  installation_cap budget_money,
  selected_endpoint text CHECK(selected_endpoint ~ '^[a-f0-9]{64}$'),
  endpoint_generation bigint NOT NULL DEFAULT 0 CHECK(endpoint_generation>=0),
  recovery_epoch text CHECK(length(recovery_epoch) BETWEEN 1 AND 200),
  UNIQUE(id,installation_id), UNIQUE(id,installation_account_id),
  FOREIGN KEY(installation_account_id,installation_id) REFERENCES budget_accounts(id,installation_id),
  CHECK((kind='installation' AND installation_account_id=id AND live_member_id IS NULL AND canonical_suppression_hash IS NULL)
    OR(kind='member' AND installation_account_id<>id AND canonical_suppression_hash IS NOT NULL AND array_to_string(provider_suppression_hashes,'') ~ '^([a-f0-9]{64})+$' AND installation_cap IS NULL AND selected_endpoint IS NULL AND recovery_epoch IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_one_installation ON budget_accounts(kind) WHERE kind='installation';
CREATE UNIQUE INDEX IF NOT EXISTS budget_live_member ON budget_accounts(installation_account_id,live_member_id) WHERE live_member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS budget_canonical_suppression ON budget_accounts(installation_account_id,canonical_suppression_hash) WHERE kind='member';
CREATE TABLE IF NOT EXISTS budget_windows (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES budget_accounts(id),
  live_member_id text REFERENCES users(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)), ends_at timestamptz NOT NULL CHECK(isfinite(ends_at) AND ends_at>starts_at),
  opening_liability budget_money NOT NULL, opening_cap budget_money NOT NULL,
  policy_revision bigint NOT NULL CHECK(policy_revision>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,account_id)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='budget_active_window_owner') THEN
    ALTER TABLE budget_accounts ADD CONSTRAINT budget_active_window_owner FOREIGN KEY(active_window_id,id) REFERENCES budget_windows(id,account_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS budget_gateway_bindings (
  id uuid PRIMARY KEY,
  installation_account_id uuid NOT NULL REFERENCES budget_accounts(id),
  member_account_id uuid NOT NULL,
  live_member_id text REFERENCES users(id) ON DELETE SET NULL,
  endpoint_hash text NOT NULL CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
  credential_generation bigint NOT NULL CHECK(credential_generation>=0),
  key_fingerprint text CHECK(key_fingerprint ~ '^[a-f0-9]{64}$'),
  agent text CHECK(agent ~ '^[a-z][a-z0-9-]{1,30}$'), incarnation uuid,
  native_team text CHECK(length(native_team) BETWEEN 1 AND 200), native_user text CHECK(length(native_user) BETWEEN 1 AND 200),
  purpose_alias text CHECK(length(purpose_alias) BETWEEN 1 AND 100),
  profile_hash text NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
  maximum_liability budget_money NOT NULL CHECK(maximum_liability>0),
  state text NOT NULL DEFAULT 'revoked' CHECK(state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(member_account_id,installation_account_id) REFERENCES budget_accounts(id,installation_account_id),
  UNIQUE(id,installation_account_id,member_account_id),
  CHECK(state='revoked' OR(live_member_id IS NOT NULL AND key_fingerprint IS NOT NULL AND agent IS NOT NULL AND incarnation IS NOT NULL AND purpose_alias IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS budget_attempts (
  id uuid PRIMARY KEY, ticket_hash text NOT NULL UNIQUE CHECK(ticket_hash ~ '^[a-f0-9]{64}$'),
  installation_account_id uuid NOT NULL, member_account_id uuid NOT NULL, binding_id uuid NOT NULL,
  live_member_id text REFERENCES users(id) ON DELETE SET NULL,
  installation_window_id uuid NOT NULL, member_window_id uuid NOT NULL,
  endpoint_hash text NOT NULL CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
  credential_generation bigint NOT NULL CHECK(credential_generation>=0),
  installation_policy_generation bigint NOT NULL CHECK(installation_policy_generation>=0),
  member_policy_generation bigint NOT NULL CHECK(member_policy_generation>=0),
  endpoint_generation bigint NOT NULL CHECK(endpoint_generation>=0), recovery_epoch text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  authority_hash text NOT NULL CHECK(authority_hash ~ '^[a-f0-9]{64}$'), authority_reference jsonb,
  profile_hash text NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
  reserved_amount budget_money NOT NULL, installation_cap_snapshot budget_money NOT NULL, member_cap_snapshot budget_money NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)), expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 seconds'), admitted_at timestamptz,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','admitted','unknown','settled','conflict','retired')),
  actual_amount budget_money, settlement_hash text CHECK(settlement_hash ~ '^[a-f0-9]{64}$'),
  conflict_reason text CHECK(conflict_reason IN ('receipt_conflict','over_reservation')),
  conflict_hash text CHECK(conflict_hash ~ '^[a-f0-9]{64}$'), highest_observed_liability budget_money NOT NULL DEFAULT 0,
  FOREIGN KEY(binding_id,installation_account_id,member_account_id) REFERENCES budget_gateway_bindings(id,installation_account_id,member_account_id),
  FOREIGN KEY(installation_window_id,installation_account_id) REFERENCES budget_windows(id,account_id),
  FOREIGN KEY(member_window_id,member_account_id) REFERENCES budget_windows(id,account_id),
  CHECK((state IN ('admitted','unknown','settled','conflict'))=(admitted_at IS NOT NULL)),
  CHECK((actual_amount IS NULL)=(settlement_hash IS NULL)),
  CHECK((state IN ('settled','conflict'))=(actual_amount IS NOT NULL)),
  CHECK(state<>'conflict' OR conflict_reason IS NOT NULL)
);
-- Rotation/profile replacement must revoke the prior binding in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS budget_active_gateway_binding ON budget_gateway_bindings(installation_account_id,member_account_id,agent,incarnation,purpose_alias) WHERE state='active';
CREATE INDEX IF NOT EXISTS budget_attempts_installation ON budget_attempts(installation_account_id,state,installation_window_id);
CREATE INDEX IF NOT EXISTS budget_attempts_member ON budget_attempts(member_account_id,state,member_window_id);

CREATE OR REPLACE FUNCTION budget_live_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
  IF TG_TABLE_NAME='budget_windows' THEN SELECT live_member_id INTO expected FROM budget_accounts WHERE id=NEW.account_id;
  ELSE SELECT live_member_id INTO expected FROM budget_accounts WHERE id=NEW.member_account_id AND kind='member'; END IF;
  IF NOT FOUND OR expected IS DISTINCT FROM NEW.live_member_id THEN RAISE EXCEPTION 'Budget member metadata must match its account'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_window_member ON budget_windows;
CREATE TRIGGER budget_window_member BEFORE INSERT ON budget_windows FOR EACH ROW EXECUTE FUNCTION budget_live_identity_guard();
DROP TRIGGER IF EXISTS budget_binding_member ON budget_gateway_bindings;
CREATE TRIGGER budget_binding_member BEFORE INSERT ON budget_gateway_bindings FOR EACH ROW EXECUTE FUNCTION budget_live_identity_guard();
DROP TRIGGER IF EXISTS budget_attempt_member ON budget_attempts;
CREATE TRIGGER budget_attempt_member BEFORE INSERT ON budget_attempts FOR EACH ROW EXECUTE FUNCTION budget_live_identity_guard();

-- Financial identity and evidence never mutate; metadata may only be removed, never reassigned.
CREATE OR REPLACE FUNCTION budget_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_body jsonb; new_body jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Budget liability and suppression cannot be deleted'; END IF;
  old_body=to_jsonb(OLD); new_body=to_jsonb(NEW);
  IF OLD.live_member_id IS DISTINCT FROM NEW.live_member_id AND NOT(OLD.live_member_id IS NOT NULL AND NEW.live_member_id IS NULL) THEN RAISE EXCEPTION 'Budget identity is immutable'; END IF;
  IF TG_TABLE_NAME='budget_windows' THEN
    IF old_body-'live_member_id' IS DISTINCT FROM new_body-'live_member_id' THEN RAISE EXCEPTION 'Budget window is immutable'; END IF;
  ELSIF TG_TABLE_NAME='budget_gateway_bindings' THEN
    IF old_body-ARRAY['live_member_id','state','agent','incarnation','native_team','native_user','purpose_alias','key_fingerprint'] IS DISTINCT FROM new_body-ARRAY['live_member_id','state','agent','incarnation','native_team','native_user','purpose_alias','key_fingerprint'] OR
      (OLD.state='revoked' AND NEW.state<>'revoked') THEN RAISE EXCEPTION 'Budget binding is immutable'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each(old_body) e WHERE e.key IN ('agent','incarnation','native_team','native_user','purpose_alias','key_fingerprint') AND new_body->e.key IS DISTINCT FROM e.value AND new_body->e.key<>'null'::jsonb) THEN RAISE EXCEPTION 'Budget binding identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME='budget_attempts' THEN
    IF old_body-ARRAY['live_member_id','authority_reference','state','admitted_at','actual_amount','settlement_hash','conflict_reason','conflict_hash','highest_observed_liability'] IS DISTINCT FROM new_body-ARRAY['live_member_id','authority_reference','state','admitted_at','actual_amount','settlement_hash','conflict_reason','conflict_hash','highest_observed_liability'] OR
      (OLD.authority_reference IS DISTINCT FROM NEW.authority_reference AND NEW.authority_reference IS NOT NULL) OR
      (OLD.admitted_at IS NOT NULL AND OLD.admitted_at IS DISTINCT FROM NEW.admitted_at) OR
      (OLD.state='unknown' AND NEW.state='admitted') OR
      NEW.highest_observed_liability<OLD.highest_observed_liability OR
      (OLD.actual_amount IS NOT NULL AND (OLD.actual_amount IS DISTINCT FROM NEW.actual_amount OR OLD.settlement_hash IS DISTINCT FROM NEW.settlement_hash)) OR
      NOT((OLD.state='prepared' AND NEW.state IN ('prepared','admitted','retired')) OR(OLD.state IN ('admitted','unknown') AND NEW.state IN ('admitted','unknown','settled','conflict')) OR(OLD.state='settled' AND NEW.state IN ('settled','conflict')) OR(OLD.state='conflict' AND NEW.state='conflict') OR(OLD.state='retired' AND NEW.state='retired')) THEN RAISE EXCEPTION 'Budget attempt evidence is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_window_immutable ON budget_windows;
CREATE TRIGGER budget_window_immutable BEFORE UPDATE OR DELETE ON budget_windows FOR EACH ROW EXECUTE FUNCTION budget_immutable();
DROP TRIGGER IF EXISTS budget_binding_immutable ON budget_gateway_bindings;
CREATE TRIGGER budget_binding_immutable BEFORE UPDATE OR DELETE ON budget_gateway_bindings FOR EACH ROW EXECUTE FUNCTION budget_immutable();
DROP TRIGGER IF EXISTS budget_attempt_immutable ON budget_attempts;
CREATE TRIGGER budget_attempt_immutable BEFORE UPDATE OR DELETE ON budget_attempts FOR EACH ROW EXECUTE FUNCTION budget_immutable();

CREATE OR REPLACE FUNCTION budget_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Budget liability and suppression cannot be deleted'; END IF;
  IF NEW.kind='member' AND TG_OP='INSERT' THEN
    PERFORM 1 FROM budget_accounts WHERE id=NEW.installation_account_id AND kind='installation' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Budget installation account required'; END IF;
    IF EXISTS(SELECT 1 FROM budget_accounts WHERE installation_account_id=NEW.installation_account_id AND id<>NEW.id AND provider_suppression_hashes && NEW.provider_suppression_hashes) THEN RAISE EXCEPTION 'Budget identity requires reconciliation'; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(OLD.id,OLD.installation_id,OLD.kind,OLD.installation_account_id,OLD.canonical_suppression_hash,OLD.provider_suppression_hashes) IS DISTINCT FROM ROW(NEW.id,NEW.installation_id,NEW.kind,NEW.installation_account_id,NEW.canonical_suppression_hash,NEW.provider_suppression_hashes) OR
      (OLD.live_member_id IS DISTINCT FROM NEW.live_member_id AND NEW.live_member_id IS NOT NULL) OR
      (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id AND NEW.organisation_id IS NOT NULL) OR
      (OLD.state='retired' AND NEW.state<>'retired') OR NEW.policy_generation<OLD.policy_generation OR NEW.endpoint_generation<OLD.endpoint_generation THEN RAISE EXCEPTION 'Budget account identity is immutable'; END IF;
    IF ROW(OLD.installation_cap,OLD.selected_endpoint,OLD.endpoint_generation,OLD.recovery_epoch,OLD.state,OLD.active_window_id) IS DISTINCT FROM ROW(NEW.installation_cap,NEW.selected_endpoint,NEW.endpoint_generation,NEW.recovery_epoch,NEW.state,NEW.active_window_id) THEN NEW.policy_generation=OLD.policy_generation+1; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_account_guard ON budget_accounts;
CREATE TRIGGER budget_account_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_accounts FOR EACH ROW EXECUTE FUNCTION budget_account_guard();
CREATE OR REPLACE FUNCTION budget_member_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.spend_cap_usd_month IS DISTINCT FROM NEW.spend_cap_usd_month THEN
    UPDATE budget_accounts SET policy_generation=policy_generation+1 WHERE live_member_id IN(NEW.user_id,OLD.user_id);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_member_cap_revision ON org_member_policy;
CREATE TRIGGER budget_member_cap_revision AFTER INSERT OR UPDATE OR DELETE ON org_member_policy FOR EACH ROW EXECUTE FUNCTION budget_member_policy_changed();
CREATE OR REPLACE FUNCTION budget_retire_member(member text,erase_metadata boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Same installation -> member -> binding -> attempt ordering as admission.
  PERFORM 1 FROM budget_accounts WHERE kind='installation' ORDER BY id FOR UPDATE;
  PERFORM 1 FROM budget_accounts WHERE live_member_id=member ORDER BY id FOR UPDATE;
  UPDATE budget_accounts SET state='retired',reason=CASE WHEN erase_metadata THEN 'member_erased' ELSE 'member_removed' END,
    policy_generation=policy_generation+1 WHERE live_member_id=member;
  UPDATE budget_gateway_bindings SET state='revoked' WHERE live_member_id=member;
  UPDATE budget_attempts SET state='retired' WHERE live_member_id=member AND state='prepared';
  IF erase_metadata THEN
    UPDATE budget_gateway_bindings SET live_member_id=NULL,agent=NULL,incarnation=NULL,native_team=NULL,native_user=NULL,purpose_alias=NULL,key_fingerprint=NULL WHERE live_member_id=member;
    UPDATE budget_attempts SET live_member_id=NULL,authority_reference=NULL WHERE live_member_id=member;
    UPDATE budget_windows SET live_member_id=NULL WHERE live_member_id=member;
    UPDATE budget_accounts SET live_member_id=NULL,organisation_id=NULL WHERE live_member_id=member;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION budget_member_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN PERFORM budget_retire_member(OLD.id,true); RETURN OLD; END IF;
  IF NEW.status='removed' AND OLD.status<>'removed' THEN PERFORM budget_retire_member(OLD.id,false); END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS budget_member_retirement ON users;
CREATE TRIGGER budget_member_retirement BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION budget_member_retirement();
COMMIT;
