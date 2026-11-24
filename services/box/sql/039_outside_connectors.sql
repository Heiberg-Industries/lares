-- 039_outside_connectors.sql: the installation's directory of outside connectors.
--
-- WHAT THIS IS. One row per outside server (an MCP address) the installation knows about, whichever
-- agents use it. Per-agent declarations in an agent's definition stay the only authority on what an
-- agent may do; this row is the installation-level record the connector screens read: a name people
-- see, the address, how the server wants you to log in, what it said its tools are, and whether setup
-- is finished.
--
--   slug             the technical name; never changes. Unique among connectors that are not retired,
--                    so a removed connector frees its name. Same shape as an agent's connection name.
--   display_name     the label people see; rename changes only this.
--   url              the server address, https only.
--   auth_kind        'none' (no login), 'token' (a pasted key) or 'signin' (the server's own login
--                    page). 'signin' is recorded here but not usable until a later release.
--   description      one short sentence, optional.
--   catalogue        what the server listed: {"tools":[{name,description,inputSchema,readOnly}]}, or
--                    NULL until a listing was taken. catalogue_hash is the sha-256 of its canonical
--                    form; catalogue_at is when it was taken. Descriptions are data, never instructions.
--   state            'setup' (saved, not finished), 'connected', or 'retired'.
--   created_by       a role label, never a person: 'owner' (made in the console), 'host' (made at the
--                    host) or 'adopted' (grouped from connections agents already had). Who did it is in
--                    the keeper audit log.
--   probed_at        when the server was last asked, without logging in, how it wants you to log in.
--
-- WRITTEN ONLY through keeper actions. The keeper reads the https hosts of rows in setup or connected
-- state when it builds the outside route; nothing an agent says can add a row.
--
-- No credential of any kind is stored here. No data is migrated: connections agents already hold are
-- adopted into the directory when the owner first asks, not by this file.
--
-- SAFE TO RUN AGAIN. Only adds what is missing.

BEGIN;

CREATE TABLE IF NOT EXISTS outside_connectors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,30}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    url text NOT NULL CHECK (length(url) <= 2048 AND url ~ '^https://'),
    auth_kind text NOT NULL CHECK (auth_kind IN ('none', 'token', 'signin')),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    catalogue jsonb CHECK (catalogue IS NULL OR (jsonb_typeof(catalogue) = 'object' AND pg_column_size(catalogue) <= 1048576)),
    catalogue_hash text CHECK (catalogue_hash IS NULL OR length(catalogue_hash) = 64),
    catalogue_at timestamptz,
    state text NOT NULL DEFAULT 'setup' CHECK (state IN ('setup', 'connected', 'retired')),
    created_by text NOT NULL CHECK (created_by IN ('owner', 'host', 'adopted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    probed_at timestamptz,
    retired_at timestamptz,
    CONSTRAINT outside_connectors_catalogue_whole CHECK ((catalogue IS NULL) = (catalogue_hash IS NULL) AND (catalogue IS NULL) = (catalogue_at IS NULL)),
    CONSTRAINT outside_connectors_retired_whole CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS outside_connectors_live_slug_idx ON outside_connectors (slug) WHERE retired_at IS NULL;

COMMIT;
