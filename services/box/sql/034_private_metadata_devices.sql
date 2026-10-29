-- Member-bound private metadata device credentials. Secrets are represented only by SHA-256
-- hashes here; read credentials remain encrypted in outside custody revisions.
BEGIN;
CREATE TABLE IF NOT EXISTS private_metadata_devices (
    id uuid PRIMARY KEY,
    owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connected_account_id text NOT NULL,
    dataset_resource_id text NOT NULL,
    dataset_id text NOT NULL CHECK (dataset_id <> ''),
    agent_name text NOT NULL CHECK (agent_name <> ''),
    connection_name text NOT NULL CHECK (connection_name <> ''),
    custody_account_id uuid NOT NULL,
    descriptor_fingerprint bytea NOT NULL CHECK (octet_length(descriptor_fingerprint) = 32),
    descriptor_json jsonb NOT NULL CHECK (octet_length(descriptor_json::text) BETWEEN 2 AND 32768),
    consent_operation_id uuid NOT NULL,
    consent_session_id text NOT NULL CHECK (consent_session_id <> ''),
    consent_json jsonb NOT NULL CHECK (octet_length(consent_json::text) BETWEEN 2 AND 4096),
    consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    upload_token_hash bytea NOT NULL CHECK (octet_length(upload_token_hash) = 32),
    read_token_hash bytea NOT NULL CHECK (octet_length(read_token_hash) = 32),
    generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
    connected_account_generation integer NOT NULL CHECK (connected_account_generation >= 0),
    state text NOT NULL CHECK (state IN ('active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    FOREIGN KEY (connected_account_id, owner_member_id)
        REFERENCES connected_accounts(id, owner_member_id) ON DELETE CASCADE,
    FOREIGN KEY (custody_account_id, owner_member_id)
        REFERENCES outside_custody_accounts(account_id, owner_member_id) ON DELETE CASCADE,
    UNIQUE (id, owner_member_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS private_metadata_one_active_device_per_account
    ON private_metadata_devices(connected_account_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS private_metadata_upload_lookup
    ON private_metadata_devices(upload_token_hash) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS private_metadata_read_lookup
    ON private_metadata_devices(read_token_hash) WHERE state = 'active';
COMMIT;
