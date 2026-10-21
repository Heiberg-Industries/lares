-- Explicit server-only associations to existing encrypted OAuth custody. No legacy adoption.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_custody_owner
    ON connected_accounts (id, owner_member_id, connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_custody_owner
    ON oauth_tokens (id, principal, provider);
CREATE TABLE IF NOT EXISTS connected_account_credentials (
    account_id text PRIMARY KEY,
    owner_member_id text NOT NULL,
    connector_id text NOT NULL,
    account_generation integer NOT NULL CHECK (account_generation >= 0),
    oauth_token_id uuid NOT NULL UNIQUE,
    FOREIGN KEY (account_id, owner_member_id, connector_id)
        REFERENCES connected_accounts (id, owner_member_id, connector_id) ON DELETE CASCADE,
    FOREIGN KEY (oauth_token_id, owner_member_id, connector_id)
        REFERENCES oauth_tokens (id, principal, provider) ON DELETE CASCADE
);
COMMIT;
