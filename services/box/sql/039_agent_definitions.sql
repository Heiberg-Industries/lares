-- 039_agent_definitions.sql — the last valid definition, and whether the folder on disk is
-- currently valid (agent-definitions spec, Part 2; ORB-278 step 2). Apply by hand on the box
-- (no auto-migrate). Idempotent.

-- One row per agent. `definition`/`duties`/`voice` are the LAST VALID contents, written every
-- time a session starts on a definition that validates. An agent whose folder is hand-edited
-- into an invalid state keeps running on this row until the folder is fixed.
CREATE TABLE IF NOT EXISTS agent_definitions (
  name        text        PRIMARY KEY,
  definition  jsonb       NOT NULL,
  duties      text        NOT NULL DEFAULT '',
  voice       text        NOT NULL DEFAULT '',
  hash        text        NOT NULL,
  -- 'valid'   the folder on disk parsed and validated at the last session start
  -- 'invalid' it did not; `status_reason` says why, and the agent is running on the row above
  status        text        NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'invalid')),
  status_reason text,
  valid_at    timestamptz NOT NULL DEFAULT now(),
  checked_at  timestamptz NOT NULL DEFAULT now()
);

-- Each agent's doors, as the keeper rendered them. Read by the console to show "set, last
-- changed 14 Sep" without ever reading a secret file (the ORB-43 rule).
CREATE TABLE IF NOT EXISTS agent_doors (
  agent       text        NOT NULL,
  kind        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT false,
  secret_set_at timestamptz,
  settings    jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, kind)
);
