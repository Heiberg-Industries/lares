-- Shared-source dedup and CRM routing state. Runtime logins need ordinary DML only.
BEGIN;

CREATE TABLE IF NOT EXISTS karakeep_seen (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS route_cursor (
  id integer PRIMARY KEY DEFAULT 1,
  cursor_at timestamptz NOT NULL,
  CONSTRAINT route_cursor_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS route_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id text NOT NULL,
  opportunity_id text,
  brand text NOT NULL,
  proposed_stage text NOT NULL,
  signal_ref text NOT NULL,
  confidence double precision NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
