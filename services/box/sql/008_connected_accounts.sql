-- Personal connected-account metadata only. Credential custody remains unchanged.
-- Additive and safe to reapply; existing OAuth rows are never adopted by email.
BEGIN;
CREATE TABLE IF NOT EXISTS connected_accounts (
    id text PRIMARY KEY CHECK (id <> ''),
    owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connector_id text NOT NULL CHECK (connector_id <> ''),
    provider_issuer text NOT NULL CHECK (provider_issuer <> ''),
    provider_subject text NOT NULL CHECK (provider_subject <> ''),
    provider_tenant_id text NOT NULL DEFAULT '',
    provider_label text NOT NULL CHECK (provider_label <> ''),
    status text NOT NULL CHECK (status IN ('ok', 'needs_reconsent', 'revoked', 'error')),
    status_reason text,
    generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
    lifecycle_revision integer NOT NULL DEFAULT 0 CHECK (lifecycle_revision >= 0),
    last_used_at timestamptz,
    UNIQUE (id, owner_member_id),
    UNIQUE (owner_member_id, connector_id, provider_issuer, provider_subject, provider_tenant_id)
);
CREATE TABLE IF NOT EXISTS connected_resource_bindings (
    id text PRIMARY KEY CHECK (id <> ''),
    owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connected_account_id text NOT NULL,
    resource_kind text NOT NULL CHECK (resource_kind <> ''),
    external_id text NOT NULL CHECK (external_id <> ''),
    provider_label text NOT NULL CHECK (provider_label <> ''),
    FOREIGN KEY (connected_account_id, owner_member_id)
        REFERENCES connected_accounts(id, owner_member_id) ON DELETE CASCADE,
    UNIQUE (connected_account_id, resource_kind, external_id)
);
COMMIT;
