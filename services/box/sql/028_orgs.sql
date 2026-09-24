-- Organisation schema only. Organisation membership is installation data.
BEGIN;

CREATE TABLE IF NOT EXISTS orgs (
  id           text        PRIMARY KEY,          -- organisation slug
  display_name text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id   text REFERENCES orgs(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_role text NOT NULL DEFAULT 'member';

-- CHECK added separately so re-running never errors; three roles is as few as the spec allows.
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_org_role_check
    CHECK (org_role IN ('owner','member','restricted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
