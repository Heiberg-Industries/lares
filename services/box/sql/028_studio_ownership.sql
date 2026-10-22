-- Studio history belongs to the current member who approved each run. Historical rows keep
-- their original channel principal and content; unknown owners remain unknown.
BEGIN;

CREATE TABLE IF NOT EXISTS studio_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief text NOT NULL,
  consensus text NOT NULL,
  spread jsonb NOT NULL,
  picks jsonb,
  principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE studio_runs ADD COLUMN IF NOT EXISTS owner_member_id text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='studio_runs'::regclass AND conname='studio_runs_owner_member_id_fkey'
  ) THEN
    ALTER TABLE studio_runs ADD CONSTRAINT studio_runs_owner_member_id_fkey
      FOREIGN KEY (owner_member_id) REFERENCES users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS studio_runs_owner_member_id_idx ON studio_runs(owner_member_id);

CREATE OR REPLACE FUNCTION guard_studio_run_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.owner_member_id IS NULL THEN
    RAISE EXCEPTION 'studio run owner is required' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id THEN
    RAISE EXCEPTION 'studio run owner is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_runs_owner_guard ON studio_runs;
CREATE TRIGGER studio_runs_owner_guard
  BEFORE INSERT OR UPDATE OF owner_member_id ON studio_runs
  FOR EACH ROW EXECUTE FUNCTION guard_studio_run_owner();

COMMIT;
