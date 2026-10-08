-- Operation metadata only. Credential values stay in protected keeper-managed files.
-- Standalone: no older-table prerequisites in the hand-built runtime image probe.
CREATE TABLE IF NOT EXISTS keeper_credentials (
  slot text PRIMARY KEY CHECK (slot = 'notion:shared'),
  version bigint NOT NULL CHECK (version > 0),
  record jsonb NOT NULL CHECK (COALESCE((
    jsonb_typeof(record) = 'object' AND
    record->>'slot' = slot AND
    (record->>'version')::bigint = version
  ), false))
);
