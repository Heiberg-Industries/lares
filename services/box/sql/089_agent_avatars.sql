-- Console identity images. Included in the existing full database dump and restore.
-- Additive and idempotent; apply before enabling avatar editing.
CREATE TABLE IF NOT EXISTS agent_avatars (
  name text PRIMARY KEY REFERENCES agent_definitions(name) ON DELETE CASCADE,
  image bytea NOT NULL CHECK (octet_length(image) <= 262144),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
