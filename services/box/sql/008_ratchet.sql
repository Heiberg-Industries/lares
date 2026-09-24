-- Persistent trust-ratchet: per-(agent, capability[, action]) autonomy level.
-- action = '' is the capability-wide default; a non-empty action is an override.
CREATE TABLE IF NOT EXISTS ratchet (
  agent       text        NOT NULL,
  capability  text        NOT NULL,
  action      text        NOT NULL DEFAULT '',
  level       text        NOT NULL CHECK (level IN ('autonomous','gated','never')),
  updated_by  text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, capability, action)
);
