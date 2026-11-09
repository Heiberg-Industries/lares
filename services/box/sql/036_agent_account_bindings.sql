-- Which connected personal account an agent works on, per purpose. Only the agent's owner sets it,
-- and only to one of their own accounts. No credential is stored here: the row names the account
-- and the account generation it was chosen at, so a reconnect makes the choice stale on purpose.
-- Re-run safe; no triggers or functions.
BEGIN;
CREATE TABLE IF NOT EXISTS agent_account_bindings (
    agent text NOT NULL REFERENCES agent_access(agent_name) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose = 'mailbox'),
    owner_member_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connected_account_id text NOT NULL,
    resource_binding_id text NOT NULL REFERENCES connected_resource_bindings(id) ON DELETE CASCADE,
    account_generation integer NOT NULL CHECK (account_generation >= 0),
    revision uuid NOT NULL,
    set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (agent, purpose),
    FOREIGN KEY (connected_account_id, owner_member_id)
        REFERENCES connected_accounts(id, owner_member_id) ON DELETE CASCADE
);
COMMIT;
