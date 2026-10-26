-- Durable, one-use evidence for an exact outside-tool approval. No credentials or raw tool input.
BEGIN;

CREATE TABLE IF NOT EXISTS outside_execution_approvals (
  call_id text PRIMARY KEY CHECK (length(call_id) BETWEEN 1 AND 128),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  member_id text NOT NULL CHECK (length(member_id) BETWEEN 1 AND 256),
  -- Stable references intentionally have no user FK so erasure does not erase another owner's approval evidence.
  approver_member_id text NOT NULL CHECK (length(approver_member_id) BETWEEN 1 AND 256),
  agent text NOT NULL CHECK (agent ~ '^[a-z][a-z0-9-]{1,30}$'),
  incarnation uuid NOT NULL,
  definition_hash bytea NOT NULL CHECK (octet_length(definition_hash)=32),
  connection_name text NOT NULL CHECK (connection_name ~ '^[a-z][a-z0-9-]{1,30}$'),
  account_id uuid NOT NULL REFERENCES outside_custody_accounts(account_id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL CHECK (credential_revision > 0 AND credential_revision <= 9007199254740991),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash)=32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS outside_execution_approvals_expiry_idx ON outside_execution_approvals(expires_at);

COMMIT;
