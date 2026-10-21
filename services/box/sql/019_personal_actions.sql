-- Private encrypted proposals and a permanent one-attempt boundary. No dispatch is enabled here.
BEGIN;
-- Suppression hashes intentionally outlive erased payloads: an original call can never be recreated.
CREATE TABLE IF NOT EXISTS personal_action_calls (
  original_call_hash text PRIMARY KEY CHECK (original_call_hash ~ '^[a-f0-9]{64}$')
);
CREATE OR REPLACE FUNCTION preserve_personal_action_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Personal action suppression is permanent'; END $$;
DROP TRIGGER IF EXISTS personal_action_call_guard ON personal_action_calls;
CREATE TRIGGER personal_action_call_guard BEFORE UPDATE OR DELETE ON personal_action_calls
  FOR EACH ROW EXECUTE FUNCTION preserve_personal_action_call();
CREATE TABLE IF NOT EXISTS personal_actions (
  id uuid PRIMARY KEY,
  payload_version integer NOT NULL CHECK (payload_version=1),
  actor_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent text NOT NULL CHECK (agent<>''),
  incarnation uuid NOT NULL,
  session_id text NOT NULL CHECK (session_id<>''),
  original_turn_id text NOT NULL CHECK (original_turn_id<>''),
  original_call_id text NOT NULL CHECK (original_call_id<>''),
  original_call_hash text NOT NULL UNIQUE REFERENCES personal_action_calls(original_call_hash),
  account_id text NOT NULL CHECK (account_id<>''),
  account_generation integer NOT NULL CHECK (account_generation>=0),
  resource_binding_id text NOT NULL CHECK (resource_binding_id<>''),
  connector_id text NOT NULL CHECK (connector_id<>''),
  kind text NOT NULL CHECK (kind='mail.send'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload_ciphertext text NOT NULL CHECK (length(payload_ciphertext) BETWEEN 1 AND 262144),
  approval_call_id text UNIQUE,
  approval_request_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_approval' CHECK (state IN
    ('awaiting_approval','awaiting_dispatch','claimed','cancelled','expired','not_dispatched','rejected','accepted','unknown')),
  attempt_id uuid UNIQUE,
  claimed_at timestamptz,
  receipt jsonb,
  completed_at timestamptz,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  CHECK ((approval_call_id IS NULL)=(approval_request_id IS NULL)),
  CHECK (state NOT IN ('awaiting_dispatch','claimed','not_dispatched','rejected','accepted','unknown') OR approval_call_id IS NOT NULL),
  CHECK ((attempt_id IS NULL)=(claimed_at IS NULL)),
  CHECK ((state IN ('claimed','not_dispatched','rejected','accepted','unknown'))=(attempt_id IS NOT NULL)),
  CHECK ((state IN ('not_dispatched','rejected','accepted','unknown'))=(completed_at IS NOT NULL)),
  CHECK ((receipt IS NULL)=(completed_at IS NULL)),
  CHECK (receipt IS NULL OR (
    (state='accepted' AND receipt=jsonb_build_object('state',state,'providerReceiptId',receipt->>'providerReceiptId')
      AND jsonb_typeof(receipt->'providerReceiptId')='string'
      AND length(receipt->>'providerReceiptId') BETWEEN 1 AND 256
      AND receipt->>'providerReceiptId' ~ '^[A-Za-z0-9._:@/+=-]+$') OR
    (state='rejected' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('provider_refused','invalid_recipient','rate_limited')) OR
    (state='not_dispatched' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('authority_changed','expired','policy_refused','credential_unavailable')) OR
    (state='unknown' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('transport_uncertain','process_interrupted'))
  ))
);
CREATE INDEX IF NOT EXISTS personal_actions_member_idx ON personal_actions(actor_member_id,created_at);
CREATE OR REPLACE FUNCTION guard_personal_action() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE call_namespace text;
BEGIN
  IF TG_OP='INSERT' THEN
    -- Length prefixes avoid delimiter ambiguity and hold no reversible call identity in suppression.
    call_namespace := length(NEW.agent)||':'||NEW.agent||
      length(NEW.incarnation::text)||':'||NEW.incarnation::text||length(NEW.session_id)||':'||NEW.session_id||
      length(NEW.original_turn_id)||':'||NEW.original_turn_id||length(NEW.original_call_id)||':'||NEW.original_call_id;
    NEW.original_call_hash := encode(sha256(convert_to(call_namespace,'UTF8')),'hex');
    INSERT INTO personal_action_calls VALUES(NEW.original_call_hash) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'Personal action original call already reserved'; END IF;
    IF NEW.state<>'awaiting_approval' OR NEW.approval_call_id IS NOT NULL OR NEW.attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Personal action must start unclaimed';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.payload_version,NEW.actor_member_id,NEW.agent,NEW.incarnation,NEW.session_id,
    NEW.original_turn_id,NEW.original_call_id,NEW.original_call_hash,NEW.account_id,NEW.account_generation,
    NEW.resource_binding_id,NEW.connector_id,NEW.kind,NEW.payload_hash,NEW.payload_ciphertext,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.payload_version,OLD.actor_member_id,OLD.agent,OLD.incarnation,OLD.session_id,
    OLD.original_turn_id,OLD.original_call_id,OLD.original_call_hash,OLD.account_id,OLD.account_generation,
    OLD.resource_binding_id,OLD.connector_id,OLD.kind,OLD.payload_hash,OLD.payload_ciphertext,OLD.created_at,OLD.expires_at)
    OR (OLD.approval_call_id IS NOT NULL AND ROW(NEW.approval_call_id,NEW.approval_request_id) IS DISTINCT FROM ROW(OLD.approval_call_id,OLD.approval_request_id))
    OR (OLD.attempt_id IS NOT NULL AND ROW(NEW.attempt_id,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.claimed_at)) THEN
    RAISE EXCEPTION 'Personal action is immutable';
  END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='awaiting_approval' AND NEW.state IN ('awaiting_dispatch','cancelled','expired')) OR
    (OLD.state='awaiting_dispatch' AND NEW.state IN ('claimed','cancelled','expired')) OR
    (OLD.state='claimed' AND NEW.state IN ('not_dispatched','rejected','accepted','unknown'))) THEN
    RAISE EXCEPTION 'Personal action transition refused';
  END IF;
  IF OLD.state<>'awaiting_approval' AND OLD.approval_call_id IS NULL AND NEW.approval_call_id IS NOT NULL THEN
    RAISE EXCEPTION 'Personal action approval linkage refused';
  END IF;
  IF OLD.receipt IS NOT NULL AND ROW(NEW.receipt,NEW.completed_at) IS DISTINCT FROM ROW(OLD.receipt,OLD.completed_at) THEN
    RAISE EXCEPTION 'Personal action receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS personal_action_guard ON personal_actions;
CREATE TRIGGER personal_action_guard BEFORE INSERT OR UPDATE ON personal_actions FOR EACH ROW EXECUTE FUNCTION guard_personal_action();
COMMIT;
