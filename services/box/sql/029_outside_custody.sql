-- Encrypted outside bearer credentials are owned separately from OAuth tokens.
-- This schema is deliberately not registered as a live provider or model tool.
BEGIN;

ALTER TABLE org_member_policy
  ADD COLUMN IF NOT EXISTS outside_custody_lock boolean NOT NULL DEFAULT true
  CHECK (outside_custody_lock IS TRUE);

CREATE TABLE IF NOT EXISTS outside_custody_accounts (
  account_id uuid PRIMARY KEY,
  owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES agent_access(agent_name) ON DELETE CASCADE,
  connection_name text NOT NULL CHECK (connection_name ~ '^[a-z][a-z0-9-]{1,30}$'),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0 AND generation <= 9007199254740991),
  active_revision bigint,
  candidate_revision bigint,
  consent_generation bigint NOT NULL CHECK (consent_generation > 0 AND consent_generation <= 9007199254740991),
  state text NOT NULL CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (active_revision IS NULL OR active_revision > 0),
  CHECK (candidate_revision IS NULL OR candidate_revision > 0),
  CHECK (state <> 'revoked' OR (active_revision IS NULL AND candidate_revision IS NULL)),
  UNIQUE (account_id,owner_member_id),
  UNIQUE (owner_member_id,resource_id,connection_name)
);
CREATE INDEX IF NOT EXISTS outside_custody_accounts_owner_idx ON outside_custody_accounts(owner_member_id,account_id);

CREATE TABLE IF NOT EXISTS outside_custody_revisions (
  account_id uuid NOT NULL,
  owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL CHECK (credential_revision > 0 AND credential_revision <= 9007199254740991),
  generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
  consent_generation bigint NOT NULL CHECK (consent_generation > 0 AND consent_generation <= 9007199254740991),
  revision_purpose text NOT NULL CHECK (revision_purpose IN ('discovery','executable')),
  policy_json jsonb NOT NULL CHECK (octet_length(policy_json::text) BETWEEN 2 AND 8192),
  policy_hash bytea NOT NULL CHECK (octet_length(policy_hash)=32),
  operation_id uuid NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,credential_revision),
  UNIQUE (account_id,operation_id),
  FOREIGN KEY (account_id,owner_member_id) REFERENCES outside_custody_accounts(account_id,owner_member_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outside_custody_operations (
  operation_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_kind text NOT NULL CHECK (operation_kind IN ('stage','apply','rollback','revoke','discover')),
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_phase text NOT NULL DEFAULT 'operation' CHECK (event_phase IN ('operation','claim','result')),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  expected_generation bigint NOT NULL CHECK (expected_generation >= 0 AND expected_generation <= 9007199254740991),
  result_generation bigint NOT NULL CHECK (result_generation > 0 AND result_generation <= 9007199254740991),
  credential_revision bigint,
  outcome text NOT NULL CHECK (outcome IN ('staged','applied','rolled-back','revoked','claimed','completed','unknown')),
  result_nonce bytea CHECK (result_nonce IS NULL OR octet_length(result_nonce)=12),
  result_ciphertext bytea CHECK (result_ciphertext IS NULL OR octet_length(result_ciphertext) BETWEEN 17 AND 65552),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (credential_revision IS NULL OR credential_revision > 0),
  CHECK ((result_nonce IS NULL) = (result_ciphertext IS NULL)),
  UNIQUE (request_id,event_phase),
  FOREIGN KEY (account_id,owner_member_id) REFERENCES outside_custody_accounts(account_id,owner_member_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS outside_custody_operations_account_idx ON outside_custody_operations(account_id,created_at);

COMMIT;
