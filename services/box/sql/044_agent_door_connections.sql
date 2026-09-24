-- Manual migration; no startup schema mutation. Current claims/connections are deleted on
-- owned slug deletion; keeper_audit remains append-only. Codes are never stored in clear.
CREATE TABLE agent_door_connections (
  agent text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('slack','telegram','email')),
  incarnation uuid NOT NULL,
  revision uuid NOT NULL,
  owner_email text NOT NULL,
  code_hash text,
  expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  principal text,
  org text,
  mailbox text,
  claimed_at timestamptz,
  applied_revision uuid,
  applied_connection jsonb,
  webhook_set_at timestamptz,
  PRIMARY KEY (agent,kind),
  CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$')
);
-- Append-only evidence retained after current connection cleanup and slug reuse.
CREATE TABLE agent_door_claim_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent text NOT NULL,
  kind text NOT NULL,
  incarnation uuid NOT NULL,
  principal text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
